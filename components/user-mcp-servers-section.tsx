"use client";

import { useEffect, useState } from "react";

type UserMcpServer = { id: string; name: string; url: string; hasAuthToken: boolean; createdAt: string };

// Personal HTTP MCP servers (UserMcpServer), rendered inside the AI settings
// panel. They are mounted into every agent run the user triggers, on any
// document; a document or workspace server with the same name takes precedence.
// The bearer token is write-only: the API only reports whether one is stored.
export function UserMcpServersSection() {
  const [servers, setServers] = useState<UserMcpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");

  useEffect(() => {
    fetch("/api/user/mcp-servers", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error ?? "Failed to load MCP servers.");
        setServers(data.servers ?? []);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load MCP servers."));
  }, []);

  async function send(method: "POST" | "DELETE", body: Record<string, unknown>) {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/user/mcp-servers", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
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
    <section className="credentials-section" id="user-mcp-servers">
      <strong className="credentials-section-title">Your MCP servers</strong>
      <p>
        HTTP MCP servers the agent can use in every run you trigger, on any document. A document or
        workspace server with the same name takes precedence. The bearer token is stored encrypted and
        never shown again; add a server with the same name to replace its URL or token.
      </p>
      <div className="env-var-list">
        {servers && servers.length > 0 ? (
          servers.map((server) => (
            <div className="env-var-row" key={server.id}>
              <code className="env-var-key">{server.name}</code>
              <span className="env-var-value" title={server.url}>
                {server.url}
                {server.hasAuthToken ? " · bearer token set" : ""}
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
          <div className="env-empty">No personal MCP servers.</div>
        ) : null}
      </div>
      <div className="env-add-row env-mcp-add-row">
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
          aria-label="Bearer token"
          autoComplete="off"
          onChange={(event) => setTokenDraft(event.target.value)}
          placeholder="bearer token (optional)"
          type="password"
          value={tokenDraft}
        />
        <button
          className="ghost-button"
          disabled={busy || !nameDraft.trim() || !urlDraft.trim()}
          onClick={async () => {
            const ok = await send("POST", {
              name: nameDraft.trim(),
              url: urlDraft.trim(),
              // Empty token keeps an existing one when re-saving the same name.
              ...(tokenDraft.trim() ? { authToken: tokenDraft.trim() } : {})
            });
            if (ok) {
              setNameDraft("");
              setUrlDraft("");
              setTokenDraft("");
            }
          }}
          type="button"
        >
          {busy ? "Saving…" : "Add"}
        </button>
      </div>
      {error ? <span className="subtle-pill env-error">{error}</span> : null}
    </section>
  );
}
