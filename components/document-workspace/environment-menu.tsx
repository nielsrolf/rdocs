"use client";

import { useEffect, useRef, useState } from "react";

type EnvVar = { key: string; masked: string; updatedAt: string };

export function EnvironmentMenu({
  documentId,
  shareToken
}: {
  documentId: string;
  shareToken: string | null;
}) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const [vars, setVars] = useState<EnvVar[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const shareBody = shareToken ? { shareToken } : {};

  async function loadVars() {
    setLoading(true);
    setError(null);
    try {
      const query = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
      const response = await fetch(`/api/documents/${documentId}/environment${query}`, {
        cache: "no-store"
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to load environment.");
        return;
      }
      setVars(data.vars ?? []);
    } catch {
      setError("Failed to load environment.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const node = detailsRef.current;
    if (!node) return;
    const handler = () => {
      if (node.open && vars === null && !loading) {
        void loadVars();
      }
    };
    node.addEventListener("toggle", handler);
    return () => node.removeEventListener("toggle", handler);
  }, [vars, loading]);

  async function handleAdd() {
    const key = keyDraft.trim();
    if (!key || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/environment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: valueDraft, ...shareBody })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to save variable.");
        return;
      }
      setVars(data.vars ?? []);
      setKeyDraft("");
      setValueDraft("");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(key: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/environment`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, ...shareBody })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to delete variable.");
        return;
      }
      setVars(data.vars ?? []);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="header-menu header-menu-env" ref={detailsRef}>
      <summary>Env</summary>
      <div className="header-menu-panel env-panel">
        <div>
          <strong>Document environment</strong>
          <p>
            Secrets injected into this document&apos;s agent runs. Values are write-only — shown
            masked, never in full. The agent does not inherit the server&apos;s environment.
          </p>
        </div>

        <div className="env-var-list">
          {loading ? (
            <div className="env-empty">Loading…</div>
          ) : vars && vars.length > 0 ? (
            vars.map((entry) => (
              <div className="env-var-row" key={entry.key}>
                <span className="env-var-key">{entry.key}</span>
                <span className="env-var-value">{entry.masked}</span>
                <button
                  aria-label={`Delete ${entry.key}`}
                  className="env-var-delete"
                  disabled={busy}
                  onClick={() => handleDelete(entry.key)}
                  title="Delete"
                  type="button"
                >
                  ✕
                </button>
              </div>
            ))
          ) : vars ? (
            <div className="env-empty">No variables yet.</div>
          ) : null}
        </div>

        <div className="env-add-row">
          <input
            aria-label="Variable name"
            onChange={(event) => setKeyDraft(event.target.value)}
            placeholder="OPENAI_API_KEY"
            value={keyDraft}
          />
          <input
            aria-label="Variable value"
            onChange={(event) => setValueDraft(event.target.value)}
            placeholder="value"
            type="password"
            value={valueDraft}
          />
          <button className="ghost-button" disabled={busy || !keyDraft.trim()} onClick={handleAdd} type="button">
            {busy ? "Saving…" : "Add"}
          </button>
        </div>

        {error ? <span className="subtle-pill env-error">{error}</span> : null}
      </div>
    </details>
  );
}
