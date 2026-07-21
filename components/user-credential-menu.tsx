"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  detectCredential,
  looksLikeMcpToken,
  type CredentialProvider
} from "@/lib/credential-detect";
import { emitTourEvent } from "@/components/onboarding-tour";
import { UserSkillsSection, type UserSkillEntry } from "@/components/user-skills-section";

type MaskedCredential = {
  provider: CredentialProvider;
  kind: "api_key" | "oauth";
  masked: string;
  label: string | null;
  updatedAt: string;
};

function credentialLabel(credential: MaskedCredential): string {
  if (credential.provider === "openrouter") return "OpenRouter API key";
  if (credential.provider === "openai") return "OpenAI API key";
  if (credential.provider === "litellm") return "LiteLLM API key";
  if (credential.provider === "github") return "GitHub access token";
  return credential.kind === "oauth" ? "Claude subscription" : "Anthropic API key";
}

// Only offered when the pasted value's format is unrecognizable — every other
// provider is detected from its prefix.
const FALLBACK_PROVIDER_OPTIONS: Array<{ value: CredentialProvider; label: string }> = [
  { value: "litellm", label: "LiteLLM API key" },
  { value: "openai", label: "OpenAI API key" },
  { value: "openrouter", label: "OpenRouter API key" },
  { value: "github", label: "GitHub access token" }
];

// Shown under the add-row for the detected/selected provider.
const PROVIDER_HINTS: Record<CredentialProvider, ReactNode> = {
  openai: (
    <>
      Used for voice-message transcription in the Slack bot (Whisper) — not for
      agent runs. Keys start with <code>sk-</code> / <code>sk-proj-</code>.
    </>
  ),
  anthropic: (
    <>
      Paste an API key (<code>sk-ant-…</code>) or a subscription token from{" "}
      <code>claude setup-token</code> (<code>sk-ant-oat…</code>) — the kind is detected
      automatically. The subscription path uses your Claude subscription, subject to
      Anthropic&apos;s ToS; use with your own account at your own risk.
    </>
  ),
  openrouter: (
    <>
      Unlocks OpenRouter models on every document you own — pick one under Agents → Model.
    </>
  ),
  litellm: (
    <>
      Unlocks LiteLLM models on every document you own — pick one under Agents → Model. If this
      server doesn&apos;t provide a default, also set <code>LITELLM_BASE_URL</code> in the
      document&apos;s Env menu.
    </>
  ),
  github: (
    <>
      Used to clone and push the repositories you link to documents. Create a{" "}
      <strong>fine-grained personal access token</strong> (GitHub → Settings → Developer settings)
      scoped to just those repositories, with <em>Contents: read &amp; write</em>. Runs you trigger
      use your token; without one, only public repositories work (read-only).
    </>
  )
};

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
  const [valueDraft, setValueDraft] = useState("");
  // Provider picked manually when the pasted value's format is unrecognizable.
  const [fallbackProvider, setFallbackProvider] = useState<CredentialProvider | "">("");
  const [busy, setBusy] = useState(false);
  const [workerCommand, setWorkerCommand] = useState<string | null>(null);
  const [workerBusy, setWorkerBusy] = useState(false);
  const [workerError, setWorkerError] = useState<string | null>(null);
  const [workerCopied, setWorkerCopied] = useState(false);

  async function handleGenerateWorkerCommand() {
    if (workerBusy) return;
    setWorkerBusy(true);
    setWorkerError(null);
    try {
      const response = await fetch("/api/user/self-hosted-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "self-hosted worker" })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.command) {
        setWorkerError(data?.error ?? "Failed to generate the command.");
        return;
      }
      setWorkerCommand(data.command);
    } catch {
      setWorkerError("Failed to generate the command.");
    } finally {
      setWorkerBusy(false);
    }
  }
  const [mcpTokens, setMcpTokens] = useState<McpToken[]>([]);
  const [skills, setSkills] = useState<UserSkillEntry[]>([]);
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
      const skillsResponse = await fetch("/api/user/skills", { cache: "no-store" });
      const skillsData = await skillsResponse.json().catch(() => null);
      if (skillsResponse.ok) {
        setSkills(skillsData.skills ?? []);
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
    const provider = detectCredential(value)?.provider ?? fallbackProvider;
    if (!value || !provider || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/user/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, value })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to save credential.");
        return;
      }
      setCredentials(data.credentials ?? []);
      setValueDraft("");
      setFallbackProvider("");
      emitTourEvent("credential-connected");
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

  const trimmedDraft = valueDraft.trim();
  const detected = detectCredential(trimmedDraft);
  const isMcpToken = looksLikeMcpToken(trimmedDraft);
  const needsFallbackChoice = Boolean(trimmedDraft) && !detected && !isMcpToken;
  const effectiveProvider = detected?.provider ?? (needsFallbackChoice ? fallbackProvider || null : null);
  const providerConnected = Boolean(
    effectiveProvider && credentials.some((credential) => credential.provider === effectiveProvider)
  );

  return (
    <details className="header-menu header-menu-right" data-tour="ai-credentials" ref={detailsRef}>
      <summary>AI credentials</summary>
      <div className="header-menu-panel env-panel credentials-panel">
        <p className="env-note">
          Looking for your <strong>default model</strong> (used for Slack mentions and new runs)?
          Configure it on the <a href="/settings/agent">agent settings page</a>, together with
          credentials and the self-hosted worker.
        </p>
        <section className="credentials-section">
          <strong className="credentials-section-title">Your AI credentials</strong>
          <p>
            One credential per provider, used for AI edits and replies on every document you own.
            Values are write-only — shown masked, never in full. A key set in a document&apos;s
            Env menu overrides these for that document.
          </p>

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

          <div className="env-add-row credentials-add-row">
            <input
              aria-label="Credential"
              onChange={(event) => setValueDraft(event.target.value)}
              placeholder="Paste any credential: sk-ant-…, sk-or-…, github_pat_…, LiteLLM key"
              type="password"
              value={valueDraft}
            />
            <button
              className="ghost-button"
              disabled={busy || !trimmedDraft || !effectiveProvider}
              onClick={handleSave}
              type="button"
            >
              {busy ? "Saving…" : providerConnected ? "Replace" : "Connect"}
            </button>
          </div>

          {detected ? (
            <p className="env-note">
              <strong>Detected: {detected.label}.</strong> {PROVIDER_HINTS[detected.provider]}
            </p>
          ) : isMcpToken ? (
            <p className="env-note env-note-error">
              That is a gdocs-ai MCP token (<code>gdai_…</code>), not a provider credential — use
              it with <code>claude mcp add</code> instead.
            </p>
          ) : needsFallbackChoice ? (
            <div className="env-note">
              <p className="credentials-fallback-label">
                Couldn&apos;t recognize this key&apos;s format. What is it?
              </p>
              <div className="credentials-fallback-options" role="radiogroup" aria-label="Credential type">
                {FALLBACK_PROVIDER_OPTIONS.map((option) => (
                  <button
                    aria-pressed={fallbackProvider === option.value}
                    className={`ghost-button${fallbackProvider === option.value ? " active" : ""}`}
                    key={option.value}
                    onClick={() => setFallbackProvider(option.value)}
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {fallbackProvider ? <p>{PROVIDER_HINTS[fallbackProvider]}</p> : null}
            </div>
          ) : (
            <p className="env-note">
              One field for everything: Anthropic API keys (<code>sk-ant-…</code>), Claude
              subscription tokens (<code>sk-ant-oat…</code>, from <code>claude setup-token</code>),
              OpenRouter keys (<code>sk-or-…</code>), GitHub tokens (<code>github_pat_…</code> /{" "}
              <code>ghp_…</code>) and LiteLLM keys — the type is detected as you paste.
            </p>
          )}
        </section>

        <section className="credentials-section">
          <strong className="credentials-section-title">Connect via MCP</strong>
          <p>
            Let a local Claude Code (or any MCP client) read and edit your documents as you.
            Creating a token copies a ready-to-paste <code>claude mcp add</code> command; the
            token is shown only once.
          </p>

          {mcpTokens.length > 0 ? (
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
          ) : null}

          <div className="credentials-actions">
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
            <p className="env-note">
              Run this in your terminal{mcpCopied ? " (already in your clipboard)" : ""}:
              <code className="env-note-command">{mcpCommand}</code>
            </p>
          ) : null}
        </section>

        <UserSkillsSection onSkillsChanged={setSkills} skills={skills} />

        {error ? <p className="env-note env-note-error">{error}</p> : null}

        <div className="env-note">
          <p>
            Prefer not to store credentials here at all? Documents can run their agents on{" "}
            <strong>your own infrastructure</strong> instead: run the worker container on any
            machine with your keys — they never leave it — and flip a document to self-hosted in
            its agent panel.
          </p>
          {workerCommand ? (
            <>
              <code className="env-note-command">{workerCommand}</code>
              <button
                className="ghost-button"
                onClick={() => {
                  void navigator.clipboard.writeText(workerCommand).then(() => {
                    setWorkerCopied(true);
                    setTimeout(() => setWorkerCopied(false), 1500);
                  });
                }}
                type="button"
              >
                {workerCopied ? "Copied" : "Copy command"}
              </button>
            </>
          ) : (
            <button
              className="ghost-button"
              disabled={workerBusy}
              onClick={() => void handleGenerateWorkerCommand()}
              type="button"
            >
              {workerBusy ? "Generating…" : "Generate worker command"}
            </button>
          )}
          {workerError ? <p className="env-note-error">{workerError}</p> : null}
        </div>
      </div>
    </details>
  );
}
