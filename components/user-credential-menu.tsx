"use client";

import { useEffect, useRef, useState } from "react";

type MaskedCredential = {
  kind: "api_key" | "oauth";
  masked: string;
  label: string | null;
  updatedAt: string;
};

const KIND_LABEL: Record<MaskedCredential["kind"], string> = {
  api_key: "Anthropic API key",
  oauth: "Claude subscription (OAuth token)"
};

// User-level "AI credential" surface, mounted in the topbar. A user connects one
// Anthropic credential (API key or `claude setup-token` OAuth token) that every
// document they OWN inherits. Values are write-only — shown masked, never in
// full — mirroring the per-document environment menu.
export function UserCredentialMenu() {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const [credential, setCredential] = useState<MaskedCredential | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [valueDraft, setValueDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/user/credentials", { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to load credential.");
        return;
      }
      setCredential(data.credential ?? null);
      setLoaded(true);
    } catch {
      setError("Failed to load credential.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const node = detailsRef.current;
    if (!node) return;
    const handler = () => {
      if (node.open && !loaded && !loading) {
        void load();
      }
    };
    node.addEventListener("toggle", handler);
    return () => node.removeEventListener("toggle", handler);
  }, [loaded, loading]);

  async function handleSave() {
    const value = valueDraft.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/user/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to save credential.");
        return;
      }
      setCredential(data.credential ?? null);
      setValueDraft("");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/user/credentials", { method: "DELETE" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to remove credential.");
        return;
      }
      setCredential(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="header-menu header-menu-right" ref={detailsRef}>
      <summary>AI credential</summary>
      <div className="header-menu-panel env-panel">
        <div>
          <strong>Your AI credential</strong>
          <p>
            Connect one Anthropic credential; every document you own uses it for AI edits and
            replies. Write-only — shown masked, never in full.
          </p>
        </div>

        <div className="env-var-list">
          {loading ? (
            <div className="env-empty">Loading…</div>
          ) : credential ? (
            <div className="env-var-row">
              <span className="env-var-key">{KIND_LABEL[credential.kind]}</span>
              <span className="env-var-value">{credential.masked}</span>
              <button
                aria-label="Remove credential"
                className="env-var-delete"
                disabled={busy}
                onClick={handleDelete}
                title="Remove"
                type="button"
              >
                ✕
              </button>
            </div>
          ) : loaded ? (
            <div className="env-empty">No credential connected.</div>
          ) : null}
        </div>

        <div className="env-add-row">
          <input
            aria-label="Anthropic API key or subscription token"
            onChange={(event) => setValueDraft(event.target.value)}
            placeholder="sk-ant-… or sk-ant-oat…"
            type="password"
            value={valueDraft}
          />
          <button
            className="ghost-button"
            disabled={busy || !valueDraft.trim()}
            onClick={handleSave}
            type="button"
          >
            {busy ? "Saving…" : credential ? "Replace" : "Connect"}
          </button>
        </div>

        <p className="subtle-pill" style={{ display: "block", whiteSpace: "normal", lineHeight: 1.4 }}>
          Paste an Anthropic API key (<code>sk-ant-…</code>) or a subscription token from{" "}
          <code>claude setup-token</code> (<code>sk-ant-oat…</code>). The kind is detected
          automatically. The subscription path uses your Claude subscription — run{" "}
          <code>claude setup-token</code> locally and paste the token. Subject to Anthropic&apos;s
          ToS; use with your own account at your own risk.
        </p>

        {error ? <span className="subtle-pill env-error">{error}</span> : null}
      </div>
    </details>
  );
}
