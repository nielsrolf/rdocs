"use client";

import { useEffect, useState, type ReactNode } from "react";

import {
  AGENT_EFFORTS,
  ANTHROPIC_AGENT_MODELS,
  DEFAULT_AGENT_EFFORT,
  DEFAULT_AGENT_MODEL,
  LITELLM_AGENT_MODELS,
  LOCAL_MODEL_PREFIX,
  OPENROUTER_AGENT_MODELS,
  agentModelProvider,
  normalizeAgentModel
} from "@/agent-core/agent-config";
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

type McpToken = {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
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

// Which user credential a model provider needs. "local" needs none — that is
// the free fallback itself.
const PROVIDER_CREDENTIAL: Record<string, CredentialProvider | null> = {
  anthropic: "anthropic",
  openrouter: "openrouter",
  litellm: "litellm",
  local: null
};

// The full-page "AI settings" screen, used in two places:
// - variant "slack": post-Slack-connect landing (app/slack/connected/page.tsx)
//   with a "Slack account connected" banner.
// - variant "settings": the same screen reachable anytime from the topbar
//   "AI settings" link (app/settings/agent/page.tsx), with a neutral heading.
// Sections: banner, AI credentials (full management — one credential per
// provider, write-only, masked), default agent model, MCP bridge tokens,
// personal skill library, and the self-hosted worker alternative. This
// replaced the old topbar "AI credentials" popup — everything the popup did
// lives here now.
export function SlackConnectConfig({
  email,
  localModel,
  variant = "slack"
}: {
  email: string;
  localModel: string | null;
  variant?: "slack" | "settings";
}) {
  const [credentials, setCredentials] = useState<MaskedCredential[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Credential paste form.
  const [valueDraft, setValueDraft] = useState("");
  // Provider picked manually when the pasted value's format is unrecognizable.
  const [fallbackProvider, setFallbackProvider] = useState<CredentialProvider | "">("");
  const [credBusy, setCredBusy] = useState(false);

  // Default model config.
  const [model, setModel] = useState<string>(DEFAULT_AGENT_MODEL);
  const [effort, setEffort] = useState<string>(DEFAULT_AGENT_EFFORT);
  const [savedConfig, setSavedConfig] = useState<{ model: string; effort: string } | null>(null);
  const [configBusy, setConfigBusy] = useState(false);

  // MCP bridge tokens. The plaintext command is only available right after
  // creating a token.
  const [mcpTokens, setMcpTokens] = useState<McpToken[]>([]);
  const [mcpCommand, setMcpCommand] = useState<string | null>(null);
  const [mcpCopied, setMcpCopied] = useState(false);
  const [mcpBusy, setMcpBusy] = useState(false);

  // Personal skill library.
  const [skills, setSkills] = useState<UserSkillEntry[]>([]);

  // Self-hosted worker explainer.
  const [showWorker, setShowWorker] = useState(false);
  const [workerCommand, setWorkerCommand] = useState<string | null>(null);
  const [workerBusy, setWorkerBusy] = useState(false);
  const [workerCopied, setWorkerCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [credRes, defaultsRes, tokenRes, skillsRes] = await Promise.all([
          fetch("/api/user/credentials", { cache: "no-store" }),
          fetch("/api/user/agent-defaults", { cache: "no-store" }),
          fetch("/api/user/mcp-tokens", { cache: "no-store" }),
          fetch("/api/user/skills", { cache: "no-store" })
        ]);
        const credData = await credRes.json().catch(() => null);
        const defaultsData = await defaultsRes.json().catch(() => null);
        const tokenData = await tokenRes.json().catch(() => null);
        const skillsData = await skillsRes.json().catch(() => null);
        if (cancelled) return;
        if (credRes.ok) setCredentials(credData?.credentials ?? []);
        if (defaultsRes.ok && defaultsData?.defaults) {
          const savedModel = defaultsData.defaults.model ?? DEFAULT_AGENT_MODEL;
          const savedEffort = defaultsData.defaults.effort ?? DEFAULT_AGENT_EFFORT;
          setModel(savedModel);
          setEffort(savedEffort);
          setSavedConfig({ model: savedModel, effort: savedEffort });
        }
        if (tokenRes.ok) setMcpTokens(tokenData?.tokens ?? []);
        if (skillsRes.ok) setSkills(skillsData?.skills ?? []);
        setLoaded(true);
      } catch {
        if (!cancelled) setError("Failed to load your settings — reload the page.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const hasCredential = (provider: CredentialProvider) =>
    credentials.some((credential) => credential.provider === provider);

  const normalizedModel = normalizeAgentModel(model);
  const provider = agentModelProvider(normalizedModel);
  const neededCredential = PROVIDER_CREDENTIAL[provider];
  const missingCredential = loaded && neededCredential !== null && !hasCredential(neededCredential);
  const fallbackName = localModel ? localModel.slice(LOCAL_MODEL_PREFIX.length) : null;

  const trimmedDraft = valueDraft.trim();
  const detected = detectCredential(trimmedDraft);
  const isMcpToken = looksLikeMcpToken(trimmedDraft);
  const needsFallbackChoice = Boolean(trimmedDraft) && !detected && !isMcpToken;
  const effectiveProvider =
    detected?.provider ?? (needsFallbackChoice ? fallbackProvider || null : null);
  const providerConnected = Boolean(
    effectiveProvider && credentials.some((credential) => credential.provider === effectiveProvider)
  );

  async function handleSaveCredential() {
    const value = valueDraft.trim();
    const targetProvider = detectCredential(value)?.provider ?? fallbackProvider;
    if (!value || !targetProvider || credBusy) return;
    setCredBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/user/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: targetProvider, value })
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
    } catch {
      setError("Failed to save credential.");
    } finally {
      setCredBusy(false);
    }
  }

  async function handleDeleteCredential(targetProvider: CredentialProvider) {
    if (credBusy) return;
    setCredBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/user/credentials", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: targetProvider })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to remove credential.");
        return;
      }
      setCredentials(data.credentials ?? []);
    } finally {
      setCredBusy(false);
    }
  }

  async function handleSaveConfig() {
    if (configBusy) return;
    setConfigBusy(true);
    setError(null);
    try {
      // Thinking only applies to Anthropic models — persist what the locked
      // selector actually shows, not a stale prior choice.
      const effortToSave = provider === "anthropic" ? effort : "off";
      const response = await fetch("/api/user/agent-defaults", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: normalizedModel, effort: effortToSave })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to save the default model.");
        return;
      }
      setSavedConfig({
        model: data?.defaults?.model ?? normalizedModel,
        effort: data?.defaults?.effort ?? effort
      });
    } catch {
      setError("Failed to save the default model.");
    } finally {
      setConfigBusy(false);
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

  async function handleGenerateWorkerCommand() {
    if (workerBusy) return;
    setWorkerBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/user/self-hosted-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "self-hosted worker" })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.command) {
        setError(data?.error ?? "Failed to generate the worker command.");
        return;
      }
      setWorkerCommand(data.command);
    } catch {
      setError("Failed to generate the worker command.");
    } finally {
      setWorkerBusy(false);
    }
  }

  const dirty =
    savedConfig === null || savedConfig.model !== normalizedModel || savedConfig.effort !== effort;
  const showLocalOption = Boolean(localModel);
  const effortLocked = provider !== "anthropic";

  return (
    <div className="slack-connect-card">
      {variant === "slack" ? (
        <section className="credentials-section slack-connect-success">
          <strong className="credentials-section-title">✅ Slack account connected</strong>
          <p>
            Your Slack account is now linked to <strong>{email}</strong>. When you mention{" "}
            <strong>@claudex</strong> (or DM it), it runs with your credentials and the default
            model you pick below.
          </p>
        </section>
      ) : (
        <section className="credentials-section slack-connect-success">
          <strong className="credentials-section-title">AI settings</strong>
          <p>
            Signed in as <strong>{email}</strong>. Agent runs you trigger — AI edits, comment
            replies, Slack mentions of <strong>@claudex</strong>, and documents without a pinned
            model — use the credentials, default model and skills configured here.
          </p>
        </section>
      )}

      <section className="credentials-section">
        <strong className="credentials-section-title">AI credentials</strong>
        <p>
          One credential per provider, used for AI edits and replies on every document you own.
          Values are write-only — shown masked, never in full. A key set in a document&apos;s Env
          menu overrides these for that document.
        </p>

        {!loaded ? (
          <p className="env-note">Loading…</p>
        ) : (
          <>
            {missingCredential ? (
              <div className="env-note env-note-error slack-connect-warning">
                <strong>⚠️ You haven&apos;t added AI credentials yet.</strong>{" "}
                {provider === "anthropic" ? (
                  <>
                    Without one, agent runs use the free local model
                    {fallbackName ? (
                      <>
                        {" "}
                        <code>{fallbackName}</code>
                      </>
                    ) : null}{" "}
                    — much slower and weaker than Claude.
                  </>
                ) : (
                  <>
                    The model you picked below needs{" "}
                    {provider === "openrouter" ? "an OpenRouter" : "a LiteLLM"} API key.
                  </>
                )}{" "}
                Add a credential below, or run agents on your own machine instead (see the
                self-hosted section at the bottom).
              </div>
            ) : null}

            <div className="env-var-list">
              {credentials.length > 0 ? (
                credentials.map((credential) => (
                  <div className="env-var-row" key={credential.provider}>
                    <span className="env-var-key">{credentialLabel(credential)}</span>
                    <span className="env-var-value">{credential.masked}</span>
                    <button
                      aria-label={`Remove ${credentialLabel(credential)}`}
                      className="env-var-delete"
                      disabled={credBusy}
                      onClick={() => handleDeleteCredential(credential.provider)}
                      title="Remove"
                      type="button"
                    >
                      ✕
                    </button>
                  </div>
                ))
              ) : (
                <div className="env-empty">No credentials connected.</div>
              )}
            </div>
          </>
        )}

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
            disabled={credBusy || !trimmedDraft || !effectiveProvider}
            onClick={handleSaveCredential}
            type="button"
          >
            {credBusy ? "Saving…" : providerConnected ? "Replace" : "Connect"}
          </button>
        </div>

        {detected ? (
          <p className="env-note">
            <strong>Detected: {detected.label}.</strong> {PROVIDER_HINTS[detected.provider]}
          </p>
        ) : isMcpToken ? (
          <p className="env-note env-note-error">
            That is an r-docs MCP token (<code>gdai_…</code>), not a provider credential — use it
            with <code>claude mcp add</code> instead.
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
        <strong className="credentials-section-title">Default model</strong>
        <p>
          Used whenever an agent runs for you and the document or channel hasn&apos;t pinned a
          model of its own (documents can override this in their agent panel).
        </p>
        <div className="slack-connect-config-row">
          <label className="agent-config-field">
            <span className="agent-config-label">Model</span>
            <select
              className="agent-config-select"
              onChange={(event) => setModel(event.target.value)}
              value={normalizedModel}
            >
              <optgroup label="Anthropic">
                {ANTHROPIC_AGENT_MODELS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} — {option.hint}
                  </option>
                ))}
              </optgroup>
              {showLocalOption ? (
                <optgroup label="Free (this server)">
                  <option value={localModel!}>{fallbackName} — free, no credential</option>
                </optgroup>
              ) : null}
              {hasCredential("openrouter") || provider === "openrouter" ? (
                <optgroup label="OpenRouter">
                  {OPENROUTER_AGENT_MODELS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                  {provider === "openrouter" &&
                  !OPENROUTER_AGENT_MODELS.some((option) => option.value === normalizedModel) ? (
                    <option value={normalizedModel}>{normalizedModel}</option>
                  ) : null}
                </optgroup>
              ) : null}
              {hasCredential("litellm") || provider === "litellm" ? (
                <optgroup label="LiteLLM">
                  {LITELLM_AGENT_MODELS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                  {provider === "litellm" &&
                  !LITELLM_AGENT_MODELS.some((option) => option.value === normalizedModel) ? (
                    <option value={normalizedModel}>{normalizedModel}</option>
                  ) : null}
                </optgroup>
              ) : null}
            </select>
          </label>
          <label className="agent-config-field">
            <span className="agent-config-label">Thinking</span>
            <select
              className="agent-config-select"
              disabled={effortLocked}
              onChange={(event) => setEffort(event.target.value)}
              title={effortLocked ? "Extended thinking applies to Anthropic models" : "Extended-thinking effort"}
              value={effortLocked ? "off" : effort}
            >
              {AGENT_EFFORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ghost-button"
            disabled={!loaded || configBusy || !dirty}
            onClick={handleSaveConfig}
            type="button"
          >
            {configBusy ? "Saving…" : dirty ? "Save default" : "Saved ✓"}
          </button>
        </div>
      </section>

      <section className="credentials-section">
        <strong className="credentials-section-title">Connect via MCP</strong>
        <p>
          Let a local Claude Code (or any MCP client) read and edit your documents as you.
          Creating a token copies a ready-to-paste <code>claude mcp add</code> command; the token
          is shown only once.
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

      <section className="credentials-section">
        <strong className="credentials-section-title">Self-hosted worker</strong>
        <p>
          Prefer not to store credentials here at all? Documents can run their agents on{" "}
          <strong>your own infrastructure</strong> instead: a Docker container that polls this app
          for jobs, runs them locally with your keys (they never leave your machine), and pushes
          results back. Flip a document to self-hosted in its agent panel afterwards.
        </p>
        {showWorker || workerCommand ? (
          <div className="slack-connect-worker">
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
                  {workerCopied ? "Copied ✓" : "Copy command"}
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
          </div>
        ) : (
          <button
            className="ghost-button"
            onClick={() => setShowWorker(true)}
            type="button"
          >
            Set up a self-hosted worker
          </button>
        )}
      </section>

      {error ? <p className="env-note env-note-error">{error}</p> : null}

      {variant === "slack" ? (
        <p className="env-note">
          All set — head back to Slack and mention <strong>@claudex</strong>. You can change all of
          this anytime under <strong>AI settings</strong> in the app topbar.
        </p>
      ) : null}
    </div>
  );
}
