import { db } from "@/lib/db";
import {
  AGENT_EFFORTS,
  ANTHROPIC_AGENT_MODELS,
  CODEX_CHATGPT_MODEL_PREFIX,
  CODEX_LITELLM_MODEL_PREFIX,
  CODEX_OPENAI_MODEL_PREFIX,
  DEFAULT_AGENT_MODEL,
  agentHarnessForModel,
  agentModelOptionLabel,
  defaultCodexAgentModelForCredentials,
  isAgentEffort,
  isCodexAgentModel,
  isStorableAgentModel,
  normalizeAgentModel,
  type AgentEffort
} from "@/lib/agent-config";
import { hasDocumentEnvKey } from "@/lib/document-env";
import { hasUserCredential } from "@/lib/user-credentials";

// Per-thread agent settings for Slack (`/settings scaffold=… model=… thinking=…`).
//
// A Slack thread is one agent conversation (triggerId "<channel>:<threadTs>");
// its settings live in SlackThreadAgentSettings and win over the channel
// document's agent config and the triggering user's defaults for every run in
// that thread (startSlackConversationRun). Slack never delivers a custom slash
// command typed INSIDE a thread, so in a thread the command is sent as
// `@claudex /settings …`; the registered `/settings` command at the top level
// opens a new thread with the settings pre-applied.

export type AgentScaffold = "claude-code" | "codex";

export type SettingsCommand =
  | { kind: "show" }
  | { kind: "reset" }
  | { kind: "set"; scaffold?: AgentScaffold; model?: string; thinking?: AgentEffort }
  | { kind: "invalid"; message: string };

export const SETTINGS_USAGE =
  "Usage: `/settings scaffold=claude code|codex model=opus-5-5 thinking=off|low|medium|high|extra|max` " +
  "(any subset). `/settings` alone shows the current settings, `/settings reset` clears them. " +
  "Inside a thread, mention me: `@claudex /settings …`.";

const COMMAND_RE = /^\/settings(?=\s|$)/i;
const KEY_RE = /\b(scaffold|harness|model|thinking|effort)\s*=\s*/gi;

function parseScaffold(value: string): AgentScaffold | null {
  const compact = value.toLowerCase().replace(/[\s_-]+/g, "");
  if (compact === "claudecode" || compact === "claude" || compact === "cc") return "claude-code";
  if (compact === "codex") return "codex";
  return null;
}

function parseThinking(value: string): AgentEffort | null {
  const compact = value.toLowerCase().replace(/[\s_-]+/g, "");
  if (compact === "none" || compact === "disabled") return "off";
  if (compact === "med") return "medium";
  if (compact === "extra" || compact === "extrahigh") return "xhigh";
  if (compact === "maximum") return "max";
  return isAgentEffort(compact) ? compact : null;
}

/**
 * Parse a `/settings …` message (bot mention already stripped). Returns null
 * when the text is not a settings command at all, so the caller treats it as an
 * ordinary prompt.
 */
export function parseSettingsCommand(text: string): SettingsCommand | null {
  const trimmed = text.trim();
  const command = COMMAND_RE.exec(trimmed);
  if (!command) return null;
  const args = trimmed.slice(command[0].length).trim();
  if (!args) return { kind: "show" };
  if (/^(reset|clear|default|defaults)$/i.test(args)) return { kind: "reset" };

  const matches = [...args.matchAll(KEY_RE)];
  const leading = matches.length ? args.slice(0, matches[0].index).trim() : args;
  if (leading) return { kind: "invalid", message: `I don't understand \`${leading}\`.` };

  const result: Extract<SettingsCommand, { kind: "set" }> = { kind: "set" };
  for (const [i, match] of matches.entries()) {
    const end = i + 1 < matches.length ? matches[i + 1].index : args.length;
    const value = args
      .slice(match.index + match[0].length, end)
      .trim()
      .replace(/^["'`](.*)["'`]$/, "$1")
      .trim();
    const key = match[1].toLowerCase();
    if (!value) return { kind: "invalid", message: `\`${key}=\` needs a value.` };
    if (key === "scaffold" || key === "harness") {
      const scaffold = parseScaffold(value);
      if (!scaffold) return { kind: "invalid", message: `Unknown scaffold \`${value}\` (use \`claude code\` or \`codex\`).` };
      result.scaffold = scaffold;
    } else if (key === "thinking" || key === "effort") {
      const thinking = parseThinking(value);
      if (!thinking) {
        return {
          kind: "invalid",
          message: `Unknown thinking level \`${value}\` (use off, low, medium, high, extra or max).`
        };
      }
      result.thinking = thinking;
    } else {
      result.model = value;
    }
  }
  return result;
}

export type AgentSettingsValue = { model: string | null; effort: string | null };

const CLAUDE_FAMILY_RE = /^(?:claude-)?(opus|sonnet|fable)(?:-latest)?$/i;

function codexRoutePrefix(codexDefaultModel: string): string {
  for (const prefix of [CODEX_LITELLM_MODEL_PREFIX, CODEX_CHATGPT_MODEL_PREFIX, CODEX_OPENAI_MODEL_PREFIX]) {
    if (codexDefaultModel.startsWith(prefix)) return prefix;
  }
  return CODEX_OPENAI_MODEL_PREFIX;
}

/** Map what a user typed as `model=` onto a storable Document.agentModel value. */
function resolveModelInput(
  raw: string,
  scaffold: AgentScaffold,
  codexDefaultModel: string
): { model: string } | { error: string } {
  const value = raw.trim();
  const family = CLAUDE_FAMILY_RE.exec(value);
  if (scaffold === "codex") {
    if (family) {
      return { error: `\`${value}\` is a Claude model; Codex runs OpenAI models such as \`gpt-5.6-terra\`.` };
    }
    const candidate = value.toLowerCase().startsWith("codex/")
      ? value
      : `${codexRoutePrefix(codexDefaultModel)}${value}`;
    return isCodexAgentModel(candidate) && isStorableAgentModel(candidate)
      ? { model: normalizeAgentModel(candidate) }
      : { error: `\`${value}\` is not a Codex model name.` };
  }
  // "opus" / "sonnet" / "fable" mean the newest model of that family.
  if (family) return { model: `claude-${family[1].toLowerCase()}-latest` };
  const lower = value.toLowerCase();
  const prefixed = lower.startsWith("claude-") ? lower : `claude-${lower}`;
  if (/^claude-[a-z]+-\d/.test(prefixed) && isStorableAgentModel(prefixed)) {
    return { model: normalizeAgentModel(prefixed) };
  }
  // Third-party models also run on the Claude Code scaffold (openrouter/…, litellm/…, local/…).
  if (isStorableAgentModel(value) && !isCodexAgentModel(value)) return { model: normalizeAgentModel(value) };
  if (isCodexAgentModel(value)) {
    return { error: `\`${value}\` is a Codex model; add \`scaffold=codex\`.` };
  }
  return { error: `Unknown model \`${value}\`.` };
}

/**
 * Apply a `set` command on top of the thread's EFFECTIVE config (thread → doc →
 * user default), returning the values to store as the thread's overrides.
 */
export function resolveSettingsUpdate(input: {
  command: Extract<SettingsCommand, { kind: "set" }>;
  current: AgentSettingsValue;
  codexDefaultModel: string;
}): { update: { agentModel?: string; agentEffort?: string } } | { error: string } {
  const { command, current, codexDefaultModel } = input;
  const currentScaffold: AgentScaffold = agentHarnessForModel(current.model);
  const update: { agentModel?: string; agentEffort?: string } = {};
  if (command.model) {
    const scaffold =
      command.scaffold ??
      (isCodexAgentModel(command.model) || command.model.toLowerCase().startsWith("codex/")
        ? "codex"
        : CLAUDE_FAMILY_RE.test(command.model) || /^claude-/i.test(command.model)
          ? "claude-code"
          : currentScaffold);
    const resolved = resolveModelInput(command.model, scaffold, codexDefaultModel);
    if ("error" in resolved) return resolved;
    update.agentModel = resolved.model;
  } else if (command.scaffold && command.scaffold !== currentScaffold) {
    update.agentModel = command.scaffold === "codex" ? codexDefaultModel : DEFAULT_AGENT_MODEL;
  }
  if (command.thinking) update.agentEffort = command.thinking;
  return { update };
}

/** Codex route usable by this thread's runs: OpenAI key → ChatGPT login → LiteLLM. */
export async function codexDefaultModelFor(input: {
  documentId: string;
  userIds: Array<string | null | undefined>;
}): Promise<string> {
  const userIds = [...new Set(input.userIds.filter((id): id is string => Boolean(id)))];
  const has = async (envKey: string, provider: Parameters<typeof hasUserCredential>[1]) => {
    if (await hasDocumentEnvKey(input.documentId, envKey)) return true;
    for (const userId of userIds) {
      if (await hasUserCredential(userId, provider)) return true;
    }
    return false;
  };
  return defaultCodexAgentModelForCredentials({
    hasOpenAiKey: await has("OPENAI_API_KEY", "openai"),
    hasChatgptAuth: await has("CODEX_CHATGPT_AUTH_JSON", "openai-chatgpt"),
    hasLiteLlmKey: await has("LITELLM_API_KEY", "litellm")
  });
}

function modelLabel(model: string): string {
  const option = ANTHROPIC_AGENT_MODELS.find((candidate) => candidate.value === model);
  if (option) return agentModelOptionLabel(option);
  for (const [prefix, via] of [
    [CODEX_OPENAI_MODEL_PREFIX, "OpenAI"],
    [CODEX_CHATGPT_MODEL_PREFIX, "ChatGPT login"],
    [CODEX_LITELLM_MODEL_PREFIX, "LiteLLM"]
  ] as const) {
    if (model.startsWith(prefix)) return `${model.slice(prefix.length)} (via ${via})`;
  }
  return model;
}

/** One-line human summary, e.g. "*Codex* · model *gpt-5.6-terra (via OpenAI)* · thinking *Max*". */
export function formatAgentSettings(settings: AgentSettingsValue): string {
  const model = settings.model ? normalizeAgentModel(settings.model) : DEFAULT_AGENT_MODEL;
  const scaffold = agentHarnessForModel(model) === "codex" ? "Codex" : "Claude Code";
  const effort = AGENT_EFFORTS.find((e) => e.value === (settings.effort ?? "off"))?.label ?? settings.effort;
  return `*${scaffold}* · model *${modelLabel(model)}* · thinking *${effort}*`;
}

export async function getThreadAgentSettings(documentId: string, triggerId: string) {
  return db.slackThreadAgentSettings.findUnique({
    where: { documentId_triggerId: { documentId, triggerId } },
    select: { agentModel: true, agentEffort: true }
  });
}

export async function hasThreadAgentSettings(documentId: string, triggerId: string): Promise<boolean> {
  return Boolean(await getThreadAgentSettings(documentId, triggerId));
}

/** Merge `update` into the thread's stored overrides (fields left out are kept). */
export async function saveThreadAgentSettings(input: {
  documentId: string;
  triggerId: string;
  update: { agentModel?: string; agentEffort?: string };
  userId: string;
}) {
  return db.slackThreadAgentSettings.upsert({
    where: { documentId_triggerId: { documentId: input.documentId, triggerId: input.triggerId } },
    create: {
      documentId: input.documentId,
      triggerId: input.triggerId,
      agentModel: input.update.agentModel ?? null,
      agentEffort: input.update.agentEffort ?? null,
      updatedById: input.userId
    },
    update: { ...input.update, updatedById: input.userId },
    select: { agentModel: true, agentEffort: true }
  });
}

export async function clearThreadAgentSettings(documentId: string, triggerId: string) {
  await db.slackThreadAgentSettings.deleteMany({ where: { documentId, triggerId } });
}

/** The document config a thread's runs start from: thread overrides win. */
export async function applyThreadAgentSettings<T extends { id: string; agentModel: string | null; agentEffort: string | null }>(
  document: T,
  triggerId: string
): Promise<{ agentModel: string | null; agentEffort: string | null }> {
  const thread = await getThreadAgentSettings(document.id, triggerId);
  return {
    agentModel: thread?.agentModel ?? document.agentModel,
    agentEffort: thread?.agentEffort ?? document.agentEffort
  };
}
