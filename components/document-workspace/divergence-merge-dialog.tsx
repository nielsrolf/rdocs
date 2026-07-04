import { useEffect, useMemo, useState } from "react";

import { getDocumentMarkdown } from "@/lib/content";
import {
  buildMergedDocument,
  diffDocumentBlocks,
  type DocBlock,
  type DocNode,
  type HunkResolution,
  type MergeHunk
} from "@/lib/document-merge";

import { logClientEvent } from "./utils";

// Manual merge resolution for an unrecoverable, multi-client divergence — the
// git-mergetool counterpart to the sole-client force-push. This tab's local copy
// could not be auto-rebased onto the server's, and a collaborator is connected so
// we must not clobber their work. The user reconciles each conflicting region,
// and the resolved document is committed as a version-checked successor of the
// server's current version (see mergeCommitDocument in lib/collaboration.ts).

function blocksToPreview(blocks: DocBlock[]): string {
  if (blocks.length === 0) return "";
  try {
    return getDocumentMarkdown({ type: "doc", content: blocks }).trim();
  } catch {
    return "";
  }
}

function HunkColumn({
  blocks,
  emptyLabel
}: {
  blocks: DocBlock[];
  emptyLabel: string;
}) {
  const preview = blocksToPreview(blocks);
  return (
    <pre className="merge-hunk-preview">
      {preview ? preview : <span className="merge-hunk-empty">{emptyLabel}</span>}
    </pre>
  );
}

export function DivergenceMergeDialog({
  documentId,
  shareToken,
  clientId,
  localContent
}: {
  documentId: string;
  shareToken: string | null;
  clientId: string;
  localContent: DocNode;
}) {
  const [serverDoc, setServerDoc] = useState<DocNode | null>(null);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [resolutions, setResolutions] = useState<Record<number, HunkResolution>>({});
  const [loading, setLoading] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadServerSnapshot() {
    setLoading(true);
    setError(null);
    const shareQuery = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
    try {
      const response = await fetch(`/api/documents/${documentId}${shareQuery}`, { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as {
        document?: { content?: DocNode; collaborationVersion?: number };
      } | null;
      if (!response.ok || !data?.document?.content || typeof data.document.collaborationVersion !== "number") {
        setError("Could not load the latest server copy. Retry, or discard your local changes.");
        setLoading(false);
        return;
      }
      setServerDoc(data.document.content);
      setBaseVersion(data.document.collaborationVersion);
      setResolutions({});
    } catch {
      setError("Could not load the latest server copy. Retry, or discard your local changes.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // documentId/shareToken are stable for a mounted dialog.
    void loadServerSnapshot();
  }, []);

  const hunks: MergeHunk[] = useMemo(
    () => (serverDoc ? diffDocumentBlocks(serverDoc, localContent) : []),
    [serverDoc, localContent]
  );
  const conflicts = hunks.filter((hunk) => hunk.kind === "conflict");

  async function applyMerge() {
    if (baseVersion === null) return;
    setCommitting(true);
    setError(null);
    const merged = buildMergedDocument(hunks, resolutions);
    try {
      const response = await fetch(`/api/documents/${documentId}/collaboration`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merge: true, baseVersion, content: merged, clientId, shareToken })
      });
      if (response.ok) {
        logClientEvent({
          scope: "collaboration-merge-commit",
          level: "warn",
          message: "merge committed; reloading to re-seed",
          data: { documentId, baseVersion }
        });
        // The collab plugin's version is fixed at editor creation, so reload to
        // adopt the merged baseline (mirrors attemptForcePushRecovery).
        window.location.reload();
        return;
      }
      if (response.status === 409) {
        // The server advanced again while we were resolving — re-merge against the
        // fresh copy. Resolutions reset because block positions may have shifted.
        setError("The document changed again on the server. It has been reloaded — please re-resolve and apply.");
        setCommitting(false);
        await loadServerSnapshot();
        return;
      }
      setError("Could not commit the merge. Retry, or discard your local changes.");
      setCommitting(false);
    } catch {
      setError("Could not commit the merge. Retry, or discard your local changes.");
      setCommitting(false);
    }
  }

  function setHunkResolution(index: number, value: HunkResolution) {
    setResolutions((current) => ({ ...current, [index]: value }));
  }

  return (
    <div className="share-modal-backdrop" role="presentation">
      <div
        aria-labelledby="merge-dialog-title"
        aria-modal="true"
        className="merge-dialog"
        role="dialog"
        tabIndex={-1}
      >
        <div className="share-modal-header">
          <div>
            <h2 id="merge-dialog-title">Resolve sync conflict</h2>
            <p>
              Your local changes could not be merged automatically and another collaborator is
              editing. Choose which version to keep for each conflict, then apply.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="empty-state">Loading the latest server copy…</div>
        ) : (
          <>
            {error ? <div className="merge-dialog-error">{error}</div> : null}
            {conflicts.length === 0 ? (
              <div className="empty-state">
                No block-level conflicts remain. Apply to adopt your version.
              </div>
            ) : (
              <div className="merge-hunk-list">
                {conflicts.map((hunk) => {
                  if (hunk.kind !== "conflict") return null;
                  const choice = resolutions[hunk.index] ?? "local";
                  return (
                    <div className="merge-hunk" key={hunk.index}>
                      <div className="merge-hunk-columns">
                        <div
                          className={`merge-hunk-side ${choice === "server" ? "merge-hunk-side-active" : ""}`}
                        >
                          <div className="merge-hunk-side-label">Server</div>
                          <HunkColumn blocks={hunk.server} emptyLabel="(not present on server)" />
                        </div>
                        <div
                          className={`merge-hunk-side ${choice === "local" ? "merge-hunk-side-active" : ""}`}
                        >
                          <div className="merge-hunk-side-label">Your version</div>
                          <HunkColumn blocks={hunk.local} emptyLabel="(deleted in your version)" />
                        </div>
                      </div>
                      <div className="merge-hunk-actions" role="radiogroup">
                        <label>
                          <input
                            checked={choice === "server"}
                            name={`hunk-${hunk.index}`}
                            onChange={() => setHunkResolution(hunk.index, "server")}
                            type="radio"
                          />
                          Keep server
                        </label>
                        <label>
                          <input
                            checked={choice === "local"}
                            name={`hunk-${hunk.index}`}
                            onChange={() => setHunkResolution(hunk.index, "local")}
                            type="radio"
                          />
                          Keep mine
                        </label>
                        <label>
                          <input
                            checked={choice === "both"}
                            name={`hunk-${hunk.index}`}
                            onChange={() => setHunkResolution(hunk.index, "both")}
                            type="radio"
                          />
                          Keep both
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="merge-dialog-footer">
              <button
                className="ghost-button"
                disabled={committing}
                onClick={() => window.location.reload()}
                type="button"
              >
                Discard my changes &amp; reload
              </button>
              <button
                className="primary-button"
                disabled={committing || baseVersion === null}
                onClick={() => void applyMerge()}
                type="button"
              >
                {committing ? "Applying…" : "Apply merge"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
