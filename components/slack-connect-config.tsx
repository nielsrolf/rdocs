"use client";

import { useEffect, useState, type ReactNode } from "react";

import {
  AGENT_EFFORTS,
  ANTHROPIC_AGENT_MODELS,
  CODEX_CHATGPT_AGENT_MODELS,
  CODEX_LITELLM_AGENT_MODELS,
  CODEX_OPENAI_AGENT_MODELS,
  defaultCodexAgentModelForCredentials,
  DEFAULT_AGENT_EFFORT,
  DEFAULT_AGENT_MODEL,
  LITELLM_AGENT_MODELS,
  LOCAL_MODEL_PREFIX,
  OPENROUTER_AGENT_MODELS,
  agentModelProvider,
  agentHarnessForModel,
  normalizeAgentModel
} from "@/agent-core/agent-config";
import {
  detectCredential,
  looksLikeMcpToken,
  type CredentialProvider
} from "@/lib/credential-detect";
import { emitTourEvent } from "@/components/onboarding-tour";
import { UserMcpServersSection } from "@/components/user-mcp-servers-section";
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
  if (credential.provider === "openai-chatgpt") return "ChatGPT subscription (Codex)";
  if (credential.provider === "litellm") return "LiteLLM API key";
  if (credential.provider === "huggingface") return "Hugging Face access token";
  if (credential.provider === "github") return "GitHub access token";
  return credential.kind === "oauth" ? "Claude subscription" : "Anthropic API key";
}

// Only offered when the pasted value's format is unrecognizable — every other
// provider is detected from its prefix.
const FALLBACK_PROVIDER_OPTIONS: Array<{ value: CredentialProvider; label: string }> = [
  { value: "litellm", label: "LiteLLM API key" },
  { value: "openai", label: "OpenAI API key" },
  { value: "openrouter", label: "OpenRouter API key" },
  { value: "huggingface", label: "Hugging Face access token" },
  { value: "github", label: "GitHub access token" }
];

// Shown under the add-row for the detected/selected provider.
const PROVIDER_HINTS: Record<CredentialProvider, ReactNode> = {
  openai: (
    <>
      Used for native Codex agent runs and voice-message transcription in the Slack bot. Keys start
      with <code>sk-</code> / <code>sk-proj-</code>. Native Codex may alternatively use the
      deployment&apos;s saved ChatGPT login.
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
  "openai-chatgpt": (
    <>
      Your ChatGPT-subscription login for Codex: paste the contents of{" "}
      <code>~/.codex/auth.json</code> from a machine where <code>codex login</code> succeeded.
      Unlocks the &quot;ChatGPT subscription&quot; Codex models; the login refreshes itself and the
      rotated token is saved back automatically. Subject to OpenAI&apos;s ToS — use with your own
      account at your own risk.
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
  huggingface: (
    <>
      Exposed as <code>HF_TOKEN</code> only to agent runs that you trigger, so Hugging Face tools
      and libraries can access private or gated resources allowed by your token. Other users&apos;
      runs never inherit your personal token.
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
  openai: "openai",
  "openai-chatgpt": "openai-chatgpt",
  openrouter: "openrouter",
  litellm: "litellm",
  local: null
};

// Providers whose credential unlocks a MODEL (as opposed to a tool credential
// like GitHub / Hugging Face). "You haven't added AI credentials yet" is only
// true when none of these is connected.
const LLM_CREDENTIAL_PROVIDERS: ReadonlySet<CredentialProvider> = new Set<CredentialProvider>([
  "anthropic",
  "openai",
  "openai-chatgpt",
  "openrouter",
  "litellm"
]);

const CREDENTIAL_DISPLAY_NAME: Record<CredentialProvider, string> = {
  anthropic: "an Anthropic API key",
  openai: "an OpenAI API key",
  "openai-chatgpt": "a ChatGPT subscription login",
  openrouter: "an OpenRouter API key",
  litellm: "a LiteLLM API key",
  huggingface: "a Hugging Face token",
  github: "a GitHub token"
};

// "Add it by doing X" for the credential the selected default model needs.
const CREDENTIAL_HOW_TO: Record<CredentialProvider, ReactNode> = {
  anthropic: (
    <>
      Add it by pasting an API key (<code>sk-ant-…</code>, from console.anthropic.com) or a Claude
      subscription token from <code>claude setup-token</code> (<code>sk-ant-oat…</code>) into the
      credential field above — the type is detected as you paste.
    </>
  ),
  openai: (
    <>
      Add it by pasting an OpenAI key (<code>sk-…</code> / <code>sk-proj-…</code>) into the
      credential field above, or paste your <code>~/.codex/auth.json</code> to use a ChatGPT
      subscription instead.
    </>
  ),
  "openai-chatgpt": (
    <>
      Add it by running <code>codex login</code> on your own machine and pasting the whole
      contents of <code>~/.codex/auth.json</code> into the credential field above.
    </>
  ),
  openrouter: (
    <>
      Add it by pasting an OpenRouter key (<code>sk-or-…</code>) into the credential field above.
    </>
  ),
  litellm: (
    <>
      Add it by pasting your LiteLLM key into the credential field above and choosing
      &quot;LiteLLM API key&quot; when asked for the type.
    </>
  ),
  huggingface: null,
  github: null
};

/** Human label for a stored model value ("Sonnet 5"), falling back to the raw value. */
function agentModelLabel(value: string): string {
  const option = [
    ...ANTHROPIC_AGENT_MODELS,
    ...OPENROUTER_AGENT_MODELS,
    ...LITELLM_AGENT_MODELS,
    ...CODEX_OPENAI_AGENT_MODELS,
    ...CODEX_CHATGPT_AGENT_MODELS,
    ...CODEX_LITELLM_AGENT_MODELS
  ].find((candidate) => candidate.value === value);
  return option?.label ?? value;
}

// The full-page "Settings" screen, used in two places:
// - variant "slack": post-Slack-connect landing (app/slack/connected/page.tsx)
//   with a "Slack account connected" banner.
// - variant "settings": the same screen reachable anytime from the topbar
//   "Settings" link (app/settings/agent/page.tsx), with a neutral heading.
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

  // Personal custom instructions, injected into the system prompt of every
  // run this user triggers (all modes, both harnesses).
  const [instructions, setInstructions] = useState("");
  const [savedInstructions, setSavedInstructions] = useState("");
  const [instructionsBusy, setInstructionsBusy] = useState(false);

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
          const savedText = defaultsData.defaults.instructions ?? "";
          setInstructions(savedText);
          setSavedInstructions(savedText);
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
  const harness = agentHarnessForModel(normalizedModel);
  const provider = agentModelProvider(normalizedModel);
  const neededCredential = PROVIDER_CREDENTIAL[provider];
  const missingCredential = loaded && neededCredential !== null && !hasCredential(neededCredential);
  const fallbackName = localModel ? localModel.slice(LOCAL_MODEL_PREFIX.length) : null;
  // Whether the account has ANY model credential. Distinguishes "you haven't
  // added AI credentials yet" (true onboarding) from "you added one, but not the
  // one your default model needs" — which used to print the former sentence
  // right above a connected LiteLLM key (2026-09-21).
  const hasAnyLlmCredential = credentials.some((credential) =>
    LLM_CREDENTIAL_PROVIDERS.has(credential.provider)
  );
  // Mirrors loadAgentEnvWithFreeFallback: a Claude selection with no Anthropic
  // credential but a connected LiteLLM key runs the same model through LiteLLM.
  const liteLlmCarriesClaude = missingCredential && provider === "anthropic" && hasCredential("litellm");
  const liteLlmClaudeName = `anthropic/${normalizedModel}`;
  const selectedModelLabel = agentModelLabel(normalizedModel);

  // One-time (per page load) explainer for the mismatch case: the user has a
  // credential, just not the one the selected default model needs. Brand-new
  // accounts keep the inline warning only — a modal here would sit on top of
  // the onboarding tour that sends them to this page.
  const [credentialDialogDismissed, setCredentialDialogDismissed] = useState(false);
  const credentialDialogOpen =
    missingCredential && hasAnyLlmCredential && !credentialDialogDismissed && neededCredential !== null;
  useEffect(() => {
    if (!credentialDialogOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCredentialDialogDismissed(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [credentialDialogOpen]);
  function focusCredentialInput() {
    setCredentialDialogDismissed(true);
    const input = document.getElementById("credential-input");
    input?.scrollIntoView({ behavior: "smooth", block: "center" });
    input?.focus();
  }
  function focusModelPicker() {
    setCredentialDialogDismissed(true);
    const select = document.getElementById("default-model-select");
    select?.scrollIntoView({ behavior: "smooth", block: "center" });
    select?.focus();
  }

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
      // The free local model has no thinking control — persist what the
      // locked selector actually shows, not a stale prior choice.
      const effortToSave = effortLocked ? "off" : effort;
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

  async function handleSaveInstructions() {
    if (instructionsBusy) return;
    setInstructionsBusy(true);
    setError(null);
    try {
      const trimmed = instructions.trim();
      const response = await fetch("/api/user/agent-defaults", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: trimmed || null })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to save custom instructions.");
        return;
      }
      const saved = data?.defaults?.instructions ?? "";
      setInstructions(saved);
      setSavedInstructions(saved);
    } catch {
      setError("Failed to save custom instructions.");
    } finally {
      setInstructionsBusy(false);
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
  // OpenRouter/LiteLLM models honor effort via a thinking-token budget (the
  // compat endpoints translate it, e.g. GPT reasoning effort / Gemini thinking
  // budget); only the free local llama.cpp model has no thinking control.
  const effortLocked = provider === "local";

  return (
    <div className="slack-connect-card">
      {credentialDialogOpen && neededCredential ? (
        <div
          className="share-modal-backdrop"
          onClick={() => setCredentialDialogDismissed(true)}
          role="presentation"
        >
          <div
            aria-labelledby="credential-dialog-title"
            aria-modal="true"
            className="share-modal credential-dialog"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="share-modal-header">
              <h2 id="credential-dialog-title">
                Your default model needs {CREDENTIAL_DISPLAY_NAME[neededCredential]}
              </h2>
              <button
                className="ghost-button"
                onClick={() => setCredentialDialogDismissed(true)}
                type="button"
              >
                Close
              </button>
            </div>
            <p>
              You have currently selected <strong>{selectedModelLabel}</strong> (
              <code>{normalizedModel}</code>) as your default model, but this requires{" "}
              {CREDENTIAL_DISPLAY_NAME[neededCredential]}, and your account doesn&apos;t have one.
            </p>
            <p>{CREDENTIAL_HOW_TO[neededCredential]}</p>
            <p>
              Or select a different provider and model in the <strong>Default model</strong>{" "}
              section — the picker offers the providers you have a key for.
            </p>
            {liteLlmCarriesClaude ? (
              <p className="env-note">
                Until then, runs you trigger use your LiteLLM key and run the same model as{" "}
                <code>{liteLlmClaudeName}</code> through LiteLLM. To make that explicit, pick the
                &quot;{selectedModelLabel} (via LiteLLM)&quot; entry in the model picker.
              </p>
            ) : null}
            <div className="credentials-actions">
              <button className="ghost-button" onClick={focusCredentialInput} type="button">
                Add the credential
              </button>
              <button className="ghost-button" onClick={focusModelPicker} type="button">
                Choose a different model
              </button>
              <button
                className="ghost-button"
                onClick={() => setCredentialDialogDismissed(true)}
                type="button"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
          <strong className="credentials-section-title">AI &amp; credentials</strong>
          <p>
            Signed in as <strong>{email}</strong>. Agent runs you trigger — AI edits, comment
            replies, Slack mentions of <strong>@claudex</strong>, and documents without a pinned
            model — use the credentials, default model and skills configured here.
          </p>
        </section>
      )}

      <section className="credentials-section" id="credentials">
        <strong className="credentials-section-title">AI credentials</strong>
        <p>
          One credential per provider. Values are encrypted and write-only — shown masked, never
          in full. Personal Hugging Face tokens are available only to runs you trigger; a key set
          in a document&apos;s Env menu is an explicit shared override for that document.
        </p>

        {!loaded ? (
          <p className="env-note">Loading…</p>
        ) : (
          <>
            {missingCredential && !hasAnyLlmCredential ? (
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
                    {neededCredential ? CREDENTIAL_DISPLAY_NAME[neededCredential] : "a credential"}.
                  </>
                )}{" "}
                Add a credential below, or run agents on your own machine instead (see the
                self-hosted section at the bottom).
              </div>
            ) : liteLlmCarriesClaude ? (
              <div className="env-note slack-connect-warning">
                <strong>ℹ️ {selectedModelLabel} runs through your LiteLLM key.</strong> Your default
                model <code>{normalizedModel}</code> needs an Anthropic API key, which you
                haven&apos;t added, so agent runs you trigger use the same model as{" "}
                <code>{liteLlmClaudeName}</code> via LiteLLM (the run timeline says so). Add an
                Anthropic key below to call Anthropic directly, or pick a LiteLLM model explicitly
                in the model picker.
              </div>
            ) : missingCredential && neededCredential ? (
              <div className="env-note env-note-error slack-connect-warning">
                <strong>
                  ⚠️ Your default model {selectedModelLabel} needs {CREDENTIAL_DISPLAY_NAME[neededCredential]}
                </strong>
                , which you haven&apos;t added. Add it below, or select a different provider and
                model in the Default model section.
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
            autoComplete="off"
            className="secret-input"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            name="credential-paste"
            onChange={(event) => setValueDraft(event.target.value)}
            id="credential-input"
            placeholder="Paste any credential: sk-ant-…, sk-or-…, hf_…, github_pat_…, LiteLLM key, ~/.codex/auth.json"
            spellCheck={false}
            type="text"
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
            OpenRouter keys (<code>sk-or-…</code>), Hugging Face tokens (<code>hf_…</code>),
            GitHub tokens (<code>github_pat_…</code> /{" "}
            <code>ghp_…</code>) and LiteLLM keys — the type is detected as you paste.
            Subscriptions work too: run <code>claude setup-token</code> (Claude) or{" "}
            <code>codex login</code> (ChatGPT) on your own machine and paste the token — for
            Codex, paste the whole contents of <code>~/.codex/auth.json</code>. That unlocks the
            &quot;ChatGPT subscription&quot; models in the Codex model picker below.
          </p>
        )}
      </section>

      <section className="credentials-section" id="default-model">
        <strong className="credentials-section-title">Default model</strong>
        <p>
          Used whenever an agent runs for you and the document or channel hasn&apos;t pinned a
          model of its own (documents can override this in their agent panel).
        </p>
        <div className="slack-connect-config-row">
          <label className="agent-config-field">
            <span className="agent-config-label">Harness</span>
            <select
              className="agent-config-select"
              onChange={(event) => setModel(
                event.target.value === "codex"
                  ? defaultCodexAgentModelForCredentials({
                      hasOpenAiKey: hasCredential("openai"),
                      hasLiteLlmKey: hasCredential("litellm"),
                      hasChatgptAuth: hasCredential("openai-chatgpt")
                    })
                  : DEFAULT_AGENT_MODEL
              )}
              value={harness}
            >
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label className="agent-config-field">
            <span className="agent-config-label">Model</span>
            <select
              className="agent-config-select"
              id="default-model-select"
              onChange={(event) => setModel(event.target.value)}
              value={normalizedModel}
            >
              {harness === "claude-code" ? <>
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
              </> : <>
                <optgroup label="OpenAI">
                  {CODEX_OPENAI_AGENT_MODELS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label} — {option.hint}</option>
                  ))}
                  {provider === "openai" && !CODEX_OPENAI_AGENT_MODELS.some((option) => option.value === normalizedModel) ? (
                    <option value={normalizedModel}>{normalizedModel}</option>
                  ) : null}
                </optgroup>
                {hasCredential("openai-chatgpt") || provider === "openai-chatgpt" ? (
                  <optgroup label="ChatGPT subscription">
                    {CODEX_CHATGPT_AGENT_MODELS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                    {provider === "openai-chatgpt" && !CODEX_CHATGPT_AGENT_MODELS.some((option) => option.value === normalizedModel) ? (
                      <option value={normalizedModel}>{normalizedModel}</option>
                    ) : null}
                  </optgroup>
                ) : null}
                {hasCredential("litellm") || provider === "litellm" ? (
                  <optgroup label="LiteLLM (OpenAI Responses)">
                    {CODEX_LITELLM_AGENT_MODELS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                    {provider === "litellm" && !CODEX_LITELLM_AGENT_MODELS.some((option) => option.value === normalizedModel) ? (
                      <option value={normalizedModel}>{normalizedModel}</option>
                    ) : null}
                  </optgroup>
                ) : null}
              </>}
            </select>
          </label>
          <label className="agent-config-field">
            <span className="agent-config-label">Thinking</span>
            <select
              className="agent-config-select"
              disabled={effortLocked}
              onChange={(event) => setEffort(event.target.value)}
              title={effortLocked ? "Thinking control is unavailable for the local model" : "Reasoning effort"}
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

      <section className="credentials-section" id="custom-instructions">
        <strong className="credentials-section-title">Custom instructions</strong>
        <p>
          Injected into the system prompt of <strong>every agent run you trigger</strong> — AI
          edits, comment replies, document conversations, and Slack mentions, on both harnesses.
          Use it for tone, language, and personal defaults; it can&apos;t override app rules.
        </p>
        <textarea
          aria-label="Custom instructions"
          className="agent-instructions-input"
          maxLength={8000}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder={"e.g. Always answer in German. Prefer concise replies. When writing code, add tests."}
          rows={5}
          value={instructions}
        />
        <div className="credentials-actions">
          <button
            className="ghost-button"
            disabled={!loaded || instructionsBusy || instructions.trim() === savedInstructions.trim()}
            onClick={handleSaveInstructions}
            type="button"
          >
            {instructionsBusy
              ? "Saving…"
              : instructions.trim() === savedInstructions.trim()
                ? "Saved ✓"
                : "Save instructions"}
          </button>
          <span className="env-note agent-instructions-count">
            {instructions.length} / 8000
          </span>
        </div>
      </section>

      <section className="credentials-section" id="mcp">
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

      <UserMcpServersSection />

      <UserSkillsSection onSkillsChanged={setSkills} skills={skills} />

      <section className="credentials-section" id="self-hosted">
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
          this anytime under <strong>Settings</strong> in the app topbar.
        </p>
      ) : null}
    </div>
  );
}
