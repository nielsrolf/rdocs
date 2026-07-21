"use client";

import { useEffect, useState } from "react";

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
import { detectCredential, type CredentialProvider } from "@/lib/credential-detect";

type MaskedCredential = { provider: CredentialProvider; masked: string };

// Which user credential a model provider needs. "local" needs none — that is
// the free fallback itself.
const PROVIDER_CREDENTIAL: Record<string, CredentialProvider | null> = {
  anthropic: "anthropic",
  openrouter: "openrouter",
  litellm: "litellm",
  local: null
};

// Agent config screen, used in two places:
// - variant "slack": post-Slack-connect landing (app/slack/connected/page.tsx)
//   with a "Slack account connected" banner.
// - variant "settings": the same screen reachable anytime from the normal UI
//   (app/settings/agent/page.tsx), with a neutral heading.
// Three blocks: banner, AI-credential status (warning + paste form +
// self-hosted alternative when missing), and the user's default agent model.
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
  const [credBusy, setCredBusy] = useState(false);

  // Default model config.
  const [model, setModel] = useState<string>(DEFAULT_AGENT_MODEL);
  const [effort, setEffort] = useState<string>(DEFAULT_AGENT_EFFORT);
  const [savedConfig, setSavedConfig] = useState<{ model: string; effort: string } | null>(null);
  const [configBusy, setConfigBusy] = useState(false);

  // Self-hosted worker explainer.
  const [showWorker, setShowWorker] = useState(false);
  const [workerCommand, setWorkerCommand] = useState<string | null>(null);
  const [workerBusy, setWorkerBusy] = useState(false);
  const [workerCopied, setWorkerCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [credRes, defaultsRes] = await Promise.all([
          fetch("/api/user/credentials", { cache: "no-store" }),
          fetch("/api/user/agent-defaults", { cache: "no-store" })
        ]);
        const credData = await credRes.json().catch(() => null);
        const defaultsData = await defaultsRes.json().catch(() => null);
        if (cancelled) return;
        if (credRes.ok) setCredentials(credData?.credentials ?? []);
        if (defaultsRes.ok && defaultsData?.defaults) {
          const savedModel = defaultsData.defaults.model ?? DEFAULT_AGENT_MODEL;
          const savedEffort = defaultsData.defaults.effort ?? DEFAULT_AGENT_EFFORT;
          setModel(savedModel);
          setEffort(savedEffort);
          setSavedConfig({ model: savedModel, effort: savedEffort });
        }
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

  const detected = detectCredential(valueDraft.trim());

  async function handleSaveCredential() {
    const value = valueDraft.trim();
    if (!value || !detected || credBusy) return;
    setCredBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/user/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: detected.provider, value })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to save credential.");
        return;
      }
      setCredentials(data.credentials ?? []);
      setValueDraft("");
    } catch {
      setError("Failed to save credential.");
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
          <strong className="credentials-section-title">Agent settings</strong>
          <p>
            Signed in as <strong>{email}</strong>. Agent runs you trigger — Slack mentions of{" "}
            <strong>@claudex</strong>, DMs, and documents without a pinned model — use the
            credentials and default model configured here.
          </p>
        </section>
      )}

      <section className="credentials-section">
        <strong className="credentials-section-title">AI credentials</strong>
        {!loaded ? (
          <p className="env-note">Loading…</p>
        ) : missingCredential ? (
          <div className="env-note env-note-error slack-connect-warning">
            <strong>⚠️ You haven&apos;t added AI credentials yet.</strong>{" "}
            {provider === "anthropic" ? (
              <>
                Without one, claudex runs on the free local model
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
                The model you picked below needs {provider === "openrouter" ? "an OpenRouter" : "a LiteLLM"}{" "}
                API key.
              </>
            )}{" "}
            Add a credential below, or run agents on your own machine instead.
          </div>
        ) : (
          <div className="env-var-list">
            {credentials.map((credential) => (
              <div className="env-var-row" key={credential.provider}>
                <span className="env-var-key">{credential.provider}</span>
                <span className="env-var-value">{credential.masked}</span>
              </div>
            ))}
          </div>
        )}

        <div className="env-add-row credentials-add-row">
          <input
            aria-label="Credential"
            onChange={(event) => setValueDraft(event.target.value)}
            placeholder="Paste a credential: sk-ant-…, sk-or-…, LiteLLM key"
            type="password"
            value={valueDraft}
          />
          <button
            className="ghost-button"
            disabled={credBusy || !detected}
            onClick={handleSaveCredential}
            type="button"
          >
            {credBusy ? "Saving…" : "Connect"}
          </button>
        </div>
        <p className="env-note">
          {detected ? (
            <>
              <strong>Detected: {detected.label}.</strong>
            </>
          ) : (
            <>
              Anthropic API keys (<code>sk-ant-…</code>), Claude subscription tokens (
              <code>sk-ant-oat…</code>, from <code>claude setup-token</code>), OpenRouter keys (
              <code>sk-or-…</code>) and LiteLLM keys are detected as you paste. Stored write-only,
              shown masked. Manage them anytime under <strong>AI credentials</strong> in the app
              topbar.
            </>
          )}
        </p>

        <div className="env-note">
          <button
            className="ghost-button"
            onClick={() => setShowWorker((value) => !value)}
            type="button"
          >
            {showWorker ? "Hide self-hosted option" : "Prefer not to share credentials? Run a self-hosted worker"}
          </button>
          {showWorker ? (
            <div className="slack-connect-worker">
              <p>
                Instead of storing keys here, you can run the agent worker on <strong>your own
                infrastructure</strong>: a Docker container that polls this app for jobs, runs
                them locally with your keys (they never leave your machine), and pushes results
                back. Flip a document to self-hosted in its agent panel afterwards.
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
          ) : null}
        </div>
      </section>

      <section className="credentials-section">
        <strong className="credentials-section-title">Default model</strong>
        <p>
          Used whenever claudex runs for you and the channel hasn&apos;t pinned a model of its own
          (channels can override this in their agent panel).
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

      {error ? <p className="env-note env-note-error">{error}</p> : null}

      {variant === "slack" ? (
        <p className="env-note">
          All set — head back to Slack and mention <strong>@claudex</strong>.
        </p>
      ) : null}
    </div>
  );
}
