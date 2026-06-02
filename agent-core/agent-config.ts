// Per-document agent configuration: which Claude model the research/edit agent
// runs as, and how much extended-thinking effort it applies. Stored on the
// Document row (agentModel / agentEffort) and resolved into Claude Agent SDK
// options here. Kept as a pure module so the mapping is unit-testable without
// touching the SDK or the database.

export const AGENT_MODELS = [
  { value: "sonnet", label: "Sonnet 4.6", hint: "Fast, capable default" },
  { value: "opus", label: "Opus 4.8", hint: "Most capable, slower" }
] as const;

export type AgentModel = (typeof AGENT_MODELS)[number]["value"];

// "off" maps to disabled extended thinking (the historical behaviour); the rest
// map to the SDK's adaptive-thinking effort levels.
export const AGENT_EFFORTS = [
  { value: "off", label: "Off", hint: "No extended thinking (fastest)" },
  { value: "low", label: "Low", hint: "Minimal thinking" },
  { value: "medium", label: "Medium", hint: "Moderate thinking" },
  { value: "high", label: "High", hint: "Deep reasoning" }
] as const;

export type AgentEffort = (typeof AGENT_EFFORTS)[number]["value"];

export const DEFAULT_AGENT_MODEL: AgentModel = "sonnet";
export const DEFAULT_AGENT_EFFORT: AgentEffort = "off";

export function isAgentModel(value: unknown): value is AgentModel {
  return typeof value === "string" && AGENT_MODELS.some((m) => m.value === value);
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
  /** Model alias / id handed to the SDK. */
  model: string;
  thinking: SdkThinking;
  /** Only set when extended thinking is enabled. */
  effort?: "low" | "medium" | "high";
  /** Stable label persisted on AiRun.model, e.g. "claude-agent-sdk:opus+high". */
  label: string;
};

/**
 * Resolve a document's stored agent config into concrete Claude Agent SDK
 * options. Falls back to `fallbackModel` (typically `process.env.CLAUDE_AGENT_MODEL`)
 * and finally to the built-in default when the document has no explicit choice.
 * An unrecognised model falls back; an unrecognised/"off"/missing effort disables
 * extended thinking — matching the pre-feature behaviour.
 */
export function resolveAgentSdkConfig(
  config: DocumentAgentConfig | null | undefined,
  fallbackModel?: string | null
): ResolvedAgentSdkConfig {
  const requested = config?.model;
  const model = isAgentModel(requested)
    ? requested
    : (fallbackModel && fallbackModel.trim()) || DEFAULT_AGENT_MODEL;

  const effort = config?.effort;
  if (effort === "low" || effort === "medium" || effort === "high") {
    return {
      model,
      thinking: { type: "adaptive" },
      effort,
      label: `claude-agent-sdk:${model}+${effort}`
    };
  }

  return {
    model,
    thinking: { type: "disabled" },
    label: `claude-agent-sdk:${model}`
  };
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
