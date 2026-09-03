"use client";

import { useEffect, useRef, useState } from "react";

type EnvVar = {
  key: string;
  masked: string;
  updatedAt: string;
  isSecret: boolean;
  isSecretAuto: boolean;
};

export function EnvironmentMenu({
  documentId,
  shareToken,
  onKeysChanged
}: {
  documentId: string;
  shareToken: string | null;
  /** Fires with the current key names after every successful load/add/delete. */
  onKeysChanged?: (keys: string[]) => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const [vars, setVars] = useState<EnvVar[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const shareBody = shareToken ? { shareToken } : {};

  function applyVars(next: EnvVar[]) {
    setVars(next);
    onKeysChanged?.(next.map((entry) => entry.key));
  }

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
      applyVars(data.vars ?? []);
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
      applyVars(data.vars ?? []);
      setKeyDraft("");
      setValueDraft("");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleSecret(entry: EnvVar) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/environment`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: entry.key, isSecret: !entry.isSecret, ...shareBody })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to update variable.");
        return;
      }
      applyVars(data.vars ?? []);
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
      applyVars(data.vars ?? []);
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
            Variables injected into this document&apos;s agent runs. <strong>Secrets</strong> (API
            keys, tokens) are shown masked; <strong>config</strong> vars (URLs, model names) are
            shown in full. The agent does not inherit the server&apos;s environment.
          </p>
          <p>
            AI providers: set <code>OPENROUTER_API_KEY</code> or <code>LITELLM_API_KEY</code> (+{" "}
            <code>LITELLM_BASE_URL</code> if the server has no default) here to unlock those models
            under Agents → Model.
          </p>
        </div>

        <div className="env-var-list">
          {loading ? (
            <div className="env-empty">Loading…</div>
          ) : vars && vars.length > 0 ? (
            vars.map((entry) => (
              <div className="env-var-row env-var-row-classified" key={entry.key}>
                <span className="env-var-key">{entry.key}</span>
                <button
                  className={`env-var-kind ${entry.isSecret ? "env-var-kind-secret" : "env-var-kind-config"}`}
                  disabled={busy}
                  onClick={() => handleToggleSecret(entry)}
                  title={
                    (entry.isSecret
                      ? "Secret: masked, and replaced with a per-run virtual key when the credential broker is enabled."
                      : "Config: plain setting, shown in full and passed to the agent verbatim.") +
                    (entry.isSecretAuto ? " (auto-detected — click to change)" : " (click to change)")
                  }
                  type="button"
                >
                  {entry.isSecret ? "secret" : "config"}
                </button>
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
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            onChange={(event) => setKeyDraft(event.target.value)}
            placeholder="OPENAI_API_KEY"
            value={keyDraft}
          />
          <input
            aria-label="Variable value"
            autoComplete="off"
            className="secret-input"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            name="env-var-value"
            onChange={(event) => setValueDraft(event.target.value)}
            placeholder="value"
            spellCheck={false}
            type="text"
            value={valueDraft}
          />
          <button className="ghost-button" disabled={busy || !keyDraft.trim()} onClick={handleAdd} type="button">
            {busy ? "Saving…" : "Add"}
          </button>
        </div>

        {error ? <span className="subtle-pill env-error">{error}</span> : null}

        <McpServersSection documentId={documentId} shareToken={shareToken} />
      </div>
    </details>
  );
}

type McpServer = { id: string; name: string; url: string; authEnvKey: string | null };

/**
 * HTTP MCP servers mounted into every agent run of this document (next to the
 * built-in gdocs/rdocs servers). The optional auth key names an environment
 * variable above whose value is sent as `Authorization: Bearer …`.
 */
function McpServersSection({ documentId, shareToken }: { documentId: string; shareToken: string | null }) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [authDraft, setAuthDraft] = useState("");
  const shareBody = shareToken ? { shareToken } : {};

  useEffect(() => {
    const query = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
    fetch(`/api/documents/${documentId}/mcp-servers${query}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error ?? "Failed to load MCP servers.");
        setServers(data.servers ?? []);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load MCP servers."));
  }, [documentId, shareToken]);

  async function send(method: "POST" | "DELETE", body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/mcp-servers`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, ...shareBody })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to update MCP servers.");
        return false;
      }
      setServers(data.servers ?? []);
      return true;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="env-mcp-section">
      <p>
        <strong>MCP servers</strong> — HTTP MCP servers the agent can use in every run of this document. The auth key
        names a variable above that is sent as a bearer token.
      </p>
      <div className="env-var-list">
        {servers && servers.length > 0 ? (
          servers.map((server) => (
            <div className="env-var-row" key={server.id}>
              <code className="env-var-key">{server.name}</code>
              <span className="env-var-value" title={server.url}>
                {server.url}
                {server.authEnvKey ? ` · auth: ${server.authEnvKey}` : ""}
              </span>
              <button
                aria-label={`Delete MCP server ${server.name}`}
                className="env-var-delete"
                disabled={busy}
                onClick={() => void send("DELETE", { name: server.name })}
                title="Delete"
                type="button"
              >
                ✕
              </button>
            </div>
          ))
        ) : servers ? (
          <div className="env-empty">No MCP servers.</div>
        ) : null}
      </div>
      <div className="env-add-row">
        <input
          aria-label="MCP server name"
          autoComplete="off"
          onChange={(event) => setNameDraft(event.target.value)}
          placeholder="name"
          value={nameDraft}
        />
        <input
          aria-label="MCP server URL"
          autoComplete="off"
          onChange={(event) => setUrlDraft(event.target.value)}
          placeholder="https://example.com/mcp"
          spellCheck={false}
          value={urlDraft}
        />
        <input
          aria-label="Auth env key"
          autoComplete="off"
          onChange={(event) => setAuthDraft(event.target.value)}
          placeholder="AUTH_ENV_KEY (optional)"
          value={authDraft}
        />
        <button
          className="ghost-button"
          disabled={busy || !nameDraft.trim() || !urlDraft.trim()}
          onClick={async () => {
            const ok = await send("POST", {
              name: nameDraft.trim(),
              url: urlDraft.trim(),
              authEnvKey: authDraft.trim() || null
            });
            if (ok) {
              setNameDraft("");
              setUrlDraft("");
              setAuthDraft("");
            }
          }}
          type="button"
        >
          {busy ? "Saving…" : "Add"}
        </button>
      </div>
      {error ? <span className="subtle-pill env-error">{error}</span> : null}
    </div>
  );
}
