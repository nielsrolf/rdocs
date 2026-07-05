"use client";

import { useEffect, useRef, useState } from "react";

type CredentialProvider = "anthropic" | "openrouter" | "litellm";

type MaskedCredential = {
  provider: CredentialProvider;
  kind: "api_key" | "oauth";
  masked: string;
  label: string | null;
  updatedAt: string;
};

function credentialLabel(credential: MaskedCredential): string {
  if (credential.provider === "openrouter") return "OpenRouter API key";
  if (credential.provider === "litellm") return "LiteLLM API key";
  return credential.kind === "oauth" ? "Claude subscription (OAuth token)" : "Anthropic API key";
}

const PROVIDER_OPTIONS: Array<{ value: CredentialProvider; label: string; placeholder: string }> = [
  { value: "anthropic", label: "Anthropic", placeholder: "sk-ant-… or sk-ant-oat…" },
  { value: "openrouter", label: "OpenRouter", placeholder: "sk-or-v1-…" },
  { value: "litellm", label: "LiteLLM", placeholder: "sk-…" }
];

type McpToken = {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

// User-level "AI credentials" surface, mounted in the topbar. A user connects
// at most one credential per provider (Anthropic API key or `claude
// setup-token` OAuth token; OpenRouter / LiteLLM API keys); every document
// they OWN inherits them. A key in a document's Env menu still wins for that
// document. Values are write-only — shown masked, never in full — mirroring
// the per-document environment menu.
export function UserCredentialMenu() {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const [credentials, setCredentials] = useState<MaskedCredential[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerDraft, setProviderDraft] = useState<CredentialProvider>("anthropic");
  const [valueDraft, setValueDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [mcpTokens, setMcpTokens] = useState<McpToken[]>([]);
  // The plaintext command is only available right after creating a token.
  const [mcpCommand, setMcpCommand] = useState<string | null>(null);
  const [mcpCopied, setMcpCopied] = useState(false);
  const [mcpBusy, setMcpBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/user/credentials", { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to load credentials.");
        return;
      }
      setCredentials(data.credentials ?? []);
      setLoaded(true);
      const tokenResponse = await fetch("/api/user/mcp-tokens", { cache: "no-store" });
      const tokenData = await tokenResponse.json().catch(() => null);
      if (tokenResponse.ok) {
        setMcpTokens(tokenData.tokens ?? []);
      }
    } catch {
      setError("Failed to load credentials.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateMcpToken() {
    if (mcpBusy) return;
    setMcpBusy(true);
    setError(null);
    setMcpCopied(false);
    try {
      const response = await fetch("/api/user/mcp-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to create MCP token.");
        return;
      }
      setMcpTokens(data.tokens ?? []);
      setMcpCommand(data.command ?? null);
      if (data.command) {
        try {
          await navigator.clipboard.writeText(data.command);
          setMcpCopied(true);
        } catch {
          // Clipboard can be unavailable (permissions, http) — the command stays visible to copy manually.
        }
      }
    } finally {
      setMcpBusy(false);
    }
  }

  async function handleCopyMcpCommand() {
    if (!mcpCommand) return;
    try {
      await navigator.clipboard.writeText(mcpCommand);
      setMcpCopied(true);
    } catch {
      setError("Copy failed — select the command text and copy it manually.");
    }
  }

  async function handleRevokeMcpToken(id: string) {
    if (mcpBusy) return;
    setMcpBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/user/mcp-tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to revoke MCP token.");
        return;
      }
      setMcpTokens(data.tokens ?? []);
    } finally {
      setMcpBusy(false);
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
        body: JSON.stringify({ provider: providerDraft, value })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to save credential.");
        return;
      }
      setCredentials(data.credentials ?? []);
      setValueDraft("");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(provider: CredentialProvider) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/user/credentials", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to remove credential.");
        return;
      }
      setCredentials(data.credentials ?? []);
    } finally {
      setBusy(false);
    }
  }

  const providerOption = PROVIDER_OPTIONS.find((option) => option.value === providerDraft)!;
  const providerConnected = credentials.some((credential) => credential.provider === providerDraft);

  return (
    <details className="header-menu header-menu-right" ref={detailsRef}>
      <summary>AI credentials</summary>
      <div className="header-menu-panel env-panel">
        <div>
          <strong>Your AI credentials</strong>
          <p>
            Connect one credential per provider; every document you own uses them for AI edits and
            replies. Write-only — shown masked, never in full. A key set in a document&apos;s Env
            menu overrides these for that document.
          </p>
        </div>

        <div className="env-var-list">
          {loading ? (
            <div className="env-empty">Loading…</div>
          ) : credentials.length > 0 ? (
            credentials.map((credential) => (
              <div className="env-var-row" key={credential.provider}>
                <span className="env-var-key">{credentialLabel(credential)}</span>
                <span className="env-var-value">{credential.masked}</span>
                <button
                  aria-label={`Remove ${credentialLabel(credential)}`}
                  className="env-var-delete"
                  disabled={busy}
                  onClick={() => handleDelete(credential.provider)}
                  title="Remove"
                  type="button"
                >
                  ✕
                </button>
              </div>
            ))
          ) : loaded ? (
            <div className="env-empty">No credentials connected.</div>
          ) : null}
        </div>

        <div className="env-add-row">
          <select
            aria-label="Credential provider"
            onChange={(event) => setProviderDraft(event.target.value as CredentialProvider)}
            value={providerDraft}
          >
            {PROVIDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            aria-label={`${providerOption.label} credential`}
            onChange={(event) => setValueDraft(event.target.value)}
            placeholder={providerOption.placeholder}
            type="password"
            value={valueDraft}
          />
          <button
            className="ghost-button"
            disabled={busy || !valueDraft.trim()}
            onClick={handleSave}
            type="button"
          >
            {busy ? "Saving…" : providerConnected ? "Replace" : "Connect"}
          </button>
        </div>

        <p className="subtle-pill" style={{ display: "block", whiteSpace: "normal", lineHeight: 1.4 }}>
          <strong>Anthropic</strong> — paste an API key (<code>sk-ant-…</code>) or a subscription
          token from <code>claude setup-token</code> (<code>sk-ant-oat…</code>); the kind is
          detected automatically. The subscription path uses your Claude subscription — subject to
          Anthropic&apos;s ToS; use with your own account at your own risk.
        </p>

        <p className="subtle-pill" style={{ display: "block", whiteSpace: "normal", lineHeight: 1.4 }}>
          <strong>OpenRouter / LiteLLM</strong> — connect that provider&apos;s API key here to use
          its models on every document you own, then pick the model under Agents → Model. (For
          LiteLLM also set <code>LITELLM_BASE_URL</code> in the document&apos;s Env menu if this
          server doesn&apos;t provide a default.)
        </p>

        <div style={{ borderTop: "1px solid var(--border, #444)", paddingTop: 12 }}>
          <strong>Connect via MCP</strong>
          <p>
            Let a local Claude Code (or any MCP client) read and edit your documents as you. Creating
            a token copies a ready-to-paste <code>claude mcp add</code> command; the token is shown
            only once.
          </p>

          <div className="env-var-list">
            {mcpTokens.map((token) => (
              <div className="env-var-row" key={token.id}>
                <span className="env-var-key">{token.label ?? "MCP token"}</span>
                <span className="env-var-value">
                  created {new Date(token.createdAt).toLocaleDateString()}
                  {token.lastUsedAt ? ` · last used ${new Date(token.lastUsedAt).toLocaleDateString()}` : " · never used"}
                </span>
                <button
                  aria-label="Revoke MCP token"
                  className="env-var-delete"
                  disabled={mcpBusy}
                  onClick={() => handleRevokeMcpToken(token.id)}
                  title="Revoke"
                  type="button"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <div className="env-add-row">
            <button className="ghost-button" disabled={mcpBusy} onClick={handleCreateMcpToken} type="button">
              {mcpBusy ? "Working…" : "Connect via MCP"}
            </button>
            {mcpCommand ? (
              <button className="ghost-button" disabled={mcpBusy} onClick={handleCopyMcpCommand} type="button">
                {mcpCopied ? "Copied ✓" : "Copy command"}
              </button>
            ) : null}
          </div>

          {mcpCommand ? (
            <p className="subtle-pill" style={{ display: "block", whiteSpace: "normal", lineHeight: 1.4 }}>
              Run this in your terminal{mcpCopied ? " (already in your clipboard)" : ""}:
              <code style={{ display: "block", marginTop: 6, wordBreak: "break-all", userSelect: "all" }}>
                {mcpCommand}
              </code>
            </p>
          ) : null}
        </div>

        {error ? <span className="subtle-pill env-error">{error}</span> : null}
      </div>
    </details>
  );
}
