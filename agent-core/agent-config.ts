// Per-document agent configuration: which model the research/edit agent runs
// as, and how much extended-thinking effort it applies. Stored on the Document
// row (agentModel / agentEffort) and resolved into Claude Agent SDK options
// here. Kept as a pure module so the mapping is unit-testable without touching
// the SDK or the database — and framework-free, because it ships into the
// agent container image.
//
// Three providers share the one selector:
//   - "anthropic": canonical Claude model ids, run against the Anthropic API.
//   - "openrouter": any OpenRouter slug, stored with an "openrouter/" prefix
//     (e.g. "openrouter/openai/gpt-5.2") and run through OpenRouter's
//     Anthropic-compatible endpoint via the same SDK. Requires the document
//     env to provide OPENROUTER_API_KEY (see applyProviderEnv in agent-env.ts).
//   - "litellm": any model name served by a LiteLLM proxy, stored with a
//     "litellm/" prefix (e.g. "litellm/anthropic/claude-opus-4-8") and run
//     through LiteLLM's Anthropic-compatible /v1/messages endpoint. Requires
//     LITELLM_API_KEY (document env) and LITELLM_BASE_URL (document env, or a
//     host default — see applyProviderEnv in agent-env.ts).
//   - "local": a model served by the deployment's own llama.cpp server
//     (Anthropic-compatible /v1/messages, tool use verified), stored with a
//     "local/" prefix (e.g. "local/qwen3.6-27b"). Free — no credential of any
//     kind; needs only LOCAL_MODEL_BASE_URL (host env, e.g. a tailnet IP so
//     the server can move machines with a one-line .env change). Also the
//     automatic fallback for Anthropic-model runs with no credential anywhere.

export type AgentModelProvider = "anthropic" | "openrouter" | "litellm" | "local";

export type AgentModelOption = {
  /** Value stored on Document.agentModel. */
  value: string;
  label: string;
  hint: string;
  provider: AgentModelProvider;
};

export const OPENROUTER_MODEL_PREFIX = "openrouter/";
export const LITELLM_MODEL_PREFIX = "litellm/";
export const LOCAL_MODEL_PREFIX = "local/";

export const ANTHROPIC_AGENT_MODELS: readonly AgentModelOption[] = [
  { value: "claude-sonnet-5", label: "Sonnet 5", hint: "Fast, capable default", provider: "anthropic" },
  { value: "claude-fable-5", label: "Fable 5", hint: "Most capable, premium", provider: "anthropic" },
  { value: "claude-opus-4-8", label: "Opus 4.8", hint: "Deep agentic work", provider: "anthropic" }
] as const;

// Curated OpenRouter picks shown when the document has an OPENROUTER_API_KEY.
// Any other slug is reachable via the custom-slug input; this list is just the
// sensible defaults, not a whitelist.
export const OPENROUTER_AGENT_MODELS: readonly AgentModelOption[] = [
  { value: "openrouter/z-ai/glm-5.2", label: "GLM 5.2", hint: "Zhipu flagship", provider: "openrouter" },
  { value: "openrouter/openai/gpt-5.6-sol", label: "GPT-5.6 Sol", hint: "OpenAI flagship", provider: "openrouter" },
  { value: "openrouter/openai/gpt-5.6-terra", label: "GPT-5.6 Terra", hint: "OpenAI flagship, balanced", provider: "openrouter" },
  { value: "openrouter/openai/gpt-5.6-luna", label: "GPT-5.6 Luna", hint: "OpenAI flagship, fast", provider: "openrouter" },
  { value: "openrouter/moonshotai/kimi-latest", label: "Kimi (latest)", hint: "Moonshot flagship", provider: "openrouter" },
  { value: "openrouter/minimax/minimax-m3", label: "MiniMax M3", hint: "MiniMax flagship", provider: "openrouter" },
  { value: "openrouter/google/gemini-3.5-flash", label: "Gemini 3.5 Flash", hint: "Fast Google model", provider: "openrouter" },
  { value: "openrouter/deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", hint: "Strong open model", provider: "openrouter" }
] as const;

// Curated LiteLLM picks shown when the document has a LITELLM_API_KEY. Model
// names are whatever the LiteLLM deployment routes (config.yaml model_name
// entries, often provider-prefixed wildcards); any other name is reachable via
// the custom-model input — this list is just sensible defaults, not a whitelist.
// We mirror the OpenRouter picks so a LiteLLM proxy that passes the same
// "<author>/<model>" paths through offers the identical quick-select set; the
// only differences are the "litellm/" prefix and the provider tag. Models the
// LiteLLM deployment has no native provider key for (currently Google) keep
// the "openrouter/" segment so LiteLLM routes them through OpenRouter.
const LITELLM_KEEPS_OPENROUTER_ROUTE = new Set(["openrouter/google/gemini-3.5-flash"]);
export const LITELLM_AGENT_MODELS: readonly AgentModelOption[] = OPENROUTER_AGENT_MODELS.map(
  (model) => ({
    value: LITELLM_KEEPS_OPENROUTER_ROUTE.has(model.value)
      ? `${LITELLM_MODEL_PREFIX}${model.value}`
      : `${LITELLM_MODEL_PREFIX}${model.value.slice(OPENROUTER_MODEL_PREFIX.length)}`,
    label: model.label,
    hint: model.hint,
    provider: "litellm"
  })
);

// Historical values stored on existing Document rows before canonical ids.
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8"
};

// Kept for existing consumers (UI dropdown, route enums historically derived
// from it). The Anthropic list is the always-available portion of the menu.
export const AGENT_MODELS = ANTHROPIC_AGENT_MODELS;

export type AgentModel = string;

// "off" maps to disabled extended thinking (the historical behaviour); the rest
// map to the SDK's adaptive-thinking effort levels.
export const AGENT_EFFORTS = [
  { value: "off", label: "Off", hint: "No extended thinking (fastest)" },
  { value: "low", label: "Low", hint: "Minimal thinking" },
  { value: "medium", label: "Medium", hint: "Moderate thinking" },
  { value: "high", label: "High", hint: "Deep reasoning" }
] as const;

export type AgentEffort = (typeof AGENT_EFFORTS)[number]["value"];

export const DEFAULT_AGENT_MODEL = "claude-sonnet-5";
export const DEFAULT_AGENT_EFFORT: AgentEffort = "off";

// An OpenRouter slug is "<author>/<model>", optionally with a ":variant"
// suffix (e.g. ":free"). Dots and dashes appear in real slugs; spaces, path
// traversal, and empty segments must not.
const OPENROUTER_SLUG_RE = /^[a-z0-9][\w.-]*\/[a-z0-9][\w.:-]*$/i;
// A LiteLLM model name is one or more "/"-separated segments (deployments route
// names like "anthropic/claude-opus-4-8", "openrouter/openai/gpt-5", or a bare
// alias like "embedding"). Same character discipline as OpenRouter slugs.
const LITELLM_MODEL_RE = /^[a-z0-9][\w.:-]*(\/[a-z0-9][\w.:-]*)*$/i;
const MAX_MODEL_VALUE_LENGTH = 160;

/** Map a legacy stored alias ("sonnet"/"opus") to its canonical id. */
export function normalizeAgentModel(value: string): string {
  return LEGACY_MODEL_ALIASES[value] ?? value;
}

export function isOpenRouterAgentModel(value: unknown): boolean {
  return (
    typeof value === "string" &&
    normalizeAgentModel(value).startsWith(OPENROUTER_MODEL_PREFIX)
  );
}

export function isLiteLlmAgentModel(value: unknown): boolean {
  return (
    typeof value === "string" &&
    normalizeAgentModel(value).startsWith(LITELLM_MODEL_PREFIX)
  );
}

export function isLocalAgentModel(value: unknown): boolean {
  return (
    typeof value === "string" &&
    normalizeAgentModel(value).startsWith(LOCAL_MODEL_PREFIX)
  );
}

/**
 * Which provider a stored Document.agentModel routes through. Anything without
 * a recognized provider prefix is treated as Anthropic (canonical ids, legacy
 * aliases, and unknown values that will fall back downstream).
 */
export function agentModelProvider(value: unknown): AgentModelProvider {
  if (isOpenRouterAgentModel(value)) return "openrouter";
  if (isLiteLlmAgentModel(value)) return "litellm";
  if (isLocalAgentModel(value)) return "local";
  return "anthropic";
}

function isKnownAnthropicModel(value: string): boolean {
  return ANTHROPIC_AGENT_MODELS.some((m) => m.value === value);
}

/**
 * Whether a value may be persisted as Document.agentModel: a known Anthropic
 * model (or legacy alias), "openrouter/" + a well-formed OpenRouter slug, or
 * "litellm/" + a well-formed LiteLLM model name. Shared by the PATCH route
 * (server) and the selector UI (client) so both sides validate identically.
 */
export function isStorableAgentModel(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_MODEL_VALUE_LENGTH) {
    return false;
  }
  const normalized = normalizeAgentModel(value);
  if (isKnownAnthropicModel(normalized)) return true;
  if (normalized.startsWith(OPENROUTER_MODEL_PREFIX)) {
    const slug = normalized.slice(OPENROUTER_MODEL_PREFIX.length);
    if (slug.includes("..")) return false;
    return OPENROUTER_SLUG_RE.test(slug);
  }
  if (normalized.startsWith(LITELLM_MODEL_PREFIX)) {
    const name = normalized.slice(LITELLM_MODEL_PREFIX.length);
    if (name.includes("..")) return false;
    return LITELLM_MODEL_RE.test(name);
  }
  if (normalized.startsWith(LOCAL_MODEL_PREFIX)) {
    const name = normalized.slice(LOCAL_MODEL_PREFIX.length);
    if (name.includes("..")) return false;
    return LITELLM_MODEL_RE.test(name);
  }
  return false;
}

export function isAgentModel(value: unknown): value is AgentModel {
  return isStorableAgentModel(value);
}

export function isAgentEffort(value: unknown): value is AgentEffort {
  return typeof value === "string" && AGENT_EFFORTS.some((e) => e.value === value);
}

export type DocumentAgentConfig = {
  model?: string | null;
  effort?: string | null;
};

type SdkThinking = { type: "disabled" } | { type: "adaptive" };

export type ResolvedAgentSdkConfig = {
  /** Model id handed to the SDK: a canonical Claude id, a bare OpenRouter slug, or a bare LiteLLM model name. */
  model: string;
  provider: AgentModelProvider;
  thinking: SdkThinking;
  /** Only set when extended thinking is enabled. */
  effort?: "low" | "medium" | "high";
  /**
   * Stable label persisted on AiRun.model, e.g. "claude-agent-sdk:claude-opus-4-8+high"
   * or "openrouter:openai/gpt-5.2".
   */
  label: string;
};

/**
 * Resolve a document's stored agent config into concrete Claude Agent SDK
 * options. Falls back to `fallbackModel` (typically `process.env.CLAUDE_AGENT_MODEL`)
 * and finally to the built-in default when the document has no explicit choice.
 * An unrecognised model falls back; an unrecognised/"off"/missing effort disables
 * extended thinking — matching the pre-feature behaviour.
 *
 * OpenRouter and LiteLLM models always run with extended thinking disabled:
 * the adaptive thinking params are Anthropic-specific and may be rejected by
 * the compat endpoint for non-Claude models.
 */
export function resolveAgentSdkConfig(
  config: DocumentAgentConfig | null | undefined,
  fallbackModel?: string | null
): ResolvedAgentSdkConfig {
  const requested = config?.model;
  const fallback = fallbackModel && fallbackModel.trim();
  const stored = isStorableAgentModel(requested)
    ? requested
    : fallback
      ? normalizeAgentModel(fallback)
      : DEFAULT_AGENT_MODEL;
  const normalized = normalizeAgentModel(stored);

  if (normalized.startsWith(OPENROUTER_MODEL_PREFIX)) {
    const slug = normalized.slice(OPENROUTER_MODEL_PREFIX.length);
    return {
      model: slug,
      provider: "openrouter",
      thinking: { type: "disabled" },
      label: `openrouter:${slug}`
    };
  }

  if (normalized.startsWith(LITELLM_MODEL_PREFIX)) {
    const name = normalized.slice(LITELLM_MODEL_PREFIX.length);
    return {
      model: name,
      provider: "litellm",
      thinking: { type: "disabled" },
      label: `litellm:${name}`
    };
  }

  if (normalized.startsWith(LOCAL_MODEL_PREFIX)) {
    const name = normalized.slice(LOCAL_MODEL_PREFIX.length);
    return {
      model: name,
      provider: "local",
      thinking: { type: "disabled" },
      label: `local:${name}`
    };
  }

  const effort = config?.effort;
  if (effort === "low" || effort === "medium" || effort === "high") {
    return {
      model: normalized,
      provider: "anthropic",
      thinking: { type: "adaptive" },
      effort,
      label: `claude-agent-sdk:${normalized}+${effort}`
    };
  }

  return {
    model: normalized,
    provider: "anthropic",
    thinking: { type: "disabled" },
    label: `claude-agent-sdk:${normalized}`
  };
}

// claude-fable-5 runs behind safety classifiers with a significant false-positive
// rate on benign work (the API docs call this out for security/life-sciences
// adjacent content). A classifier block surfaces as stop_reason "refusal" and
// kills the whole agent run. Opus 4.8 is the documented fallback target for
// those refusals, so a refused Fable run is rerun once on Opus. Other models
// (including OpenRouter ones) don't sit behind these classifiers — no fallback.
export const REFUSAL_FALLBACK_MODEL = "claude-opus-4-8";
const REFUSAL_PRONE_MODELS = new Set(["claude-fable-5"]);

/**
 * The model a safety-classifier-refused run should be retried on, or null when
 * no fallback applies (non-Anthropic provider, already on the fallback model,
 * or a model that doesn't run behind the refusal classifiers).
 */
export function resolveRefusalFallbackModel(
  config: DocumentAgentConfig | null | undefined,
  fallbackModel?: string | null
): string | null {
  const resolved = resolveAgentSdkConfig(config, fallbackModel);
  if (resolved.provider !== "anthropic") return null;
  return REFUSAL_PRONE_MODELS.has(resolved.model) ? REFUSAL_FALLBACK_MODEL : null;
}

// Agent turn budget. The default is effectively unbounded: wall-clock timeouts are
// the real guard against a runaway agent, not an arbitrary turn count. A small cap
// makes legitimate multi-step work (e.g. a git-merge resolution that reads files,
// edits, then re-checks `git status`) die mid-task with "Max turns reached". Both
// the research/edit agent and the merge-conflict resolver use this; override per
// call site via env only if you have a specific reason.
export const DEFAULT_AGENT_MAX_TURNS = 1_000_000;

export function parseMaxTurns(
  raw: string | null | undefined,
  fallback: number = DEFAULT_AGENT_MAX_TURNS
): number {
  if (raw == null || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
