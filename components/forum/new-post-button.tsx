"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useDialogDismiss } from "@/components/document-workspace/use-dialog-dismiss";

type DocumentOption = { id: string; title: string };
type GroupOption = { id: string; name: string };

export function NewPostButton({
  documents,
  groups
}: {
  documents: DocumentOption[];
  groups: GroupOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [documentId, setDocumentId] = useState(documents[0]?.id ?? "");
  const [audience, setAudience] = useState("existing");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (!busy) setOpen(false);
  };
  const dialogRef = useDialogDismiss<HTMLDivElement>(close);

  async function submit() {
    if (!documentId) return;
    setBusy(true);
    setError(null);
    try {
      const audiencePayload = audience.startsWith("group:")
        ? { type: "group", groupId: audience.slice("group:".length) }
        : { type: audience };
      const response = await fetch("/api/forum/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, audience: audiencePayload })
      });
      const data = (await response.json().catch(() => null)) as
        | { documentId?: string; error?: string }
        | null;
      if (!response.ok) {
        setError(data?.error ?? "Could not publish the post.");
        return;
      }
      setOpen(false);
      router.push(`/forum/${data?.documentId ?? documentId}`);
      router.refresh();
    } catch {
      setError("Could not publish the post.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="forum-btn" onClick={() => setOpen(true)} type="button">
        New Post
      </button>
      {open ? (
        <div className="share-modal-backdrop" onClick={close} role="presentation">
          <div
            aria-labelledby="new-forum-post-title"
            aria-modal="true"
            className="share-modal forum-new-post-modal"
            onClick={(event) => event.stopPropagation()}
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="share-modal-header">
              <div>
                <h2 id="new-forum-post-title">New Post</h2>
                <p>Choose a document and who should be able to read it.</p>
              </div>
              <button className="forum-btn-ghost" disabled={busy} onClick={close} type="button">
                Close
              </button>
            </div>

            {documents.length > 0 ? (
              <div className="forum-new-post-fields">
                <label>
                  <span>Document</span>
                  <select onChange={(event) => setDocumentId(event.target.value)} value={documentId}>
                    {documents.map((document) => (
                      <option key={document.id} value={document.id}>
                        {document.title || "Untitled"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Share with</span>
                  <select onChange={(event) => setAudience(event.target.value)} value={audience}>
                    <option value="existing">People who already have access</option>
                    <option value="public">Everyone (public)</option>
                    {groups.map((group) => (
                      <option key={group.id} value={`group:${group.id}`}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="forum-new-post-help">
                  Choosing a group gives that group view access. You can change permissions later from the document’s share menu.
                </p>
                {error ? <p className="forum-error">{error}</p> : null}
                <div className="forum-new-post-actions">
                  <button className="forum-btn" disabled={busy} onClick={submit} type="button">
                    {busy ? "Posting…" : "Post"}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <p className="forum-empty">You have no unposted documents with edit access.</p>
                <a className="forum-btn-ghost" href="/dashboard">
                  Open Studio
                </a>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
