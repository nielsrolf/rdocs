"use client";

import { useRef, useState } from "react";

type ApiTokenRecord = { id: string; label: string | null; createdAt: string; lastUsedAt: string | null };

// Discovery + setup surface for the self-hosted / pull agent runner
// (Document.runnerMode). Owner-only: only the actual owner may flip the
// toggle (enforced again server-side in PATCH /api/documents/:id) because it
// decides whose AI credentials every collaborator's run authenticates with.
//
// The panel mints a real bearer token and shows the real run command for the
// published worker image (docker.io/nielsrolf/rdocs-worker, multi-arch;
// override via SELF_HOSTED_WORKER_IMAGE).
export function SelfHostedMenu({
  documentId,
  runnerMode,
  isOwner,
  onRunnerModeChange
}: {
  documentId: string;
  runnerMode: string;
  isOwner: boolean;
  onRunnerModeChange: (mode: "managed" | "selfHosted") => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [tokens, setTokens] = useState<ApiTokenRecord[] | null>(null);
  const [copied, setCopied] = useState(false);

  const isSelfHosted = runnerMode === "selfHosted";

  async function handleMintToken() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const response = await fetch("/api/user/self-hosted-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: `self-hosted: ${documentId}` })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to create token.");
        return;
      }
      setCommand(data.command ?? null);
      setTokens(data.tokens ?? null);
    } catch {
      setError("Failed to create token.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    if (!command) return;
    await navigator.clipboard.writeText(command).catch(() => null);
    setCopied(true);
  }

  if (!isOwner) {
    // Collaborators just get a plain disclosure, no controls — the owner made
    // this trust decision, not them.
    return isSelfHosted ? (
      <span className="subtle-pill" title="This document's agent runs execute on the owner's own infrastructure, using the owner's AI credentials.">
        Self-hosted runner
      </span>
    ) : null;
  }

  return (
    <details className="header-menu header-menu-env" ref={detailsRef}>
      <summary>{isSelfHosted ? "Self-hosted ✓" : "Self-hosted"}</summary>
      <div className="header-menu-panel env-panel">
        <div>
          <strong>Self-hosted runner setup</strong>
          <p>
            When enabled, this app does not clone or run agent jobs for this document at all — it
            only hands off a job description. Your own worker (running on your infrastructure)
            polls for work and pushes results back. Every collaborator&apos;s runs on this document
            will use <strong>your</strong> connected AI credentials, not theirs.
          </p>
          <p className="env-note env-note-error">
            The self-hosted worker/docker image is not built yet — this only sets up the
            server-side plumbing (job queue + API). See{" "}
            <code>runner/self-hosted/README.md</code> in the repo for the HTTP contract.
          </p>
        </div>

        <label className="env-add-row" style={{ alignItems: "center" }}>
          <input
            aria-label="Enable self-hosted runner"
            checked={isSelfHosted}
            onChange={(event) => onRunnerModeChange(event.target.checked ? "selfHosted" : "managed")}
            type="checkbox"
          />
          <span>Run this document&apos;s agent jobs on my own infrastructure</span>
        </label>

        {isSelfHosted ? (
          <>
            <button className="ghost-button" disabled={busy} onClick={handleMintToken} type="button">
              {busy ? "Working…" : "Create worker token"}
            </button>
            {command ? (
              <>
                <pre className="env-empty" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                  {command}
                </pre>
                <button className="ghost-button" onClick={handleCopy} type="button">
                  {copied ? "Copied ✓" : "Copy command"}
                </button>
              </>
            ) : null}
            {tokens && tokens.length > 0 ? (
              <div className="env-var-list">
                {tokens.map((t) => (
                  <div className="env-var-row" key={t.id}>
                    <span className="env-var-key">{t.label ?? "(unlabeled)"}</span>
                    <span className="env-var-value">
                      created {new Date(t.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {error ? <span className="subtle-pill env-error">{error}</span> : null}
      </div>
    </details>
  );
}
