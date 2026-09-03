import { promises as fs } from "node:fs";
import path from "node:path";

import {
  PREPARING_DOCUMENT_UPDATE,
  SUBMITTING_FINAL_RESPONSE,
  submissionRejectedMessage
} from "./lifecycle-messages";
import { z } from "zod";

import {
  buildSystemPrompt,
  buildUserPrompt,
  MAX_SUBMISSION_ATTEMPTS as SHARED_MAX_SUBMISSION_ATTEMPTS,
  normalizeSubmittedOutput,
  submitResponseSchema,
  type ClaudeAgentProgressEvent,
  type ClaudeAgentRunOptions,
  type ClaudeResearchAgentInput,
  type ClaudeResearchAgentOutput
} from "./agent";
import { applyAgentConfigDirEnv, buildAgentEnv } from "./agent-env";
import { resolveCodexAgentConfig } from "./agent-config";
import { CodexAppServerClient, type CodexNotification } from "./codex-app-server";
import {
  createTurnPark,
  KEEP_ALIVE_EXPIRED_NUDGE,
  KEEP_ALIVE_RECHECK_MS,
  KEEP_ALIVE_RECHECK_NUDGE,
  MAX_KEEP_ALIVE_MINUTES,
  PARK_TIMEOUT_NUDGE,
  type TurnPark
} from "./turn-park";

export type CodexResearchAgentOptions = ClaudeAgentRunOptions;
export const MAX_SUBMISSION_ATTEMPTS = SHARED_MAX_SUBMISSION_ATTEMPTS;
/** The free-form `config` object the app-server accepts on thread/start. */
type CodexConfigObject = Record<string, unknown>;

// OpenAI structured outputs require every property to be required. Codex uses
// empty strings/lists for fields that do not apply to the current mode; the
// shared normalizer/validator then applies the same semantics as Claude's
// optional submit_response arguments.
const codexSubmitResponseSchema = z.object({
  replacementText: submitResponseSchema.replacementText.unwrap(),
  reply: submitResponseSchema.reply.unwrap(),
  sources: submitResponseSchema.sources.unwrap(),
  images: z.array(z.object({ path: z.string(), alt: z.string(), caption: z.string() })),
  widgets: submitResponseSchema.widgets.unwrap(),
  summary: submitResponseSchema.summary.unwrap(),
  suggestions: z.array(z.object({ findText: z.string(), replacementText: z.string(), reason: z.string() })),
  comments: submitResponseSchema.comments.unwrap()
});

export const CODEX_SUBMISSION_JSON_SCHEMA = z.toJSONSchema(codexSubmitResponseSchema, {
  target: "draft-7",
  unrepresentable: "any"
});

function codexPrompt(input: ClaudeResearchAgentInput): string {
  const finishing = `Return the final response as JSON matching the supplied output schema. Every field is required: use an empty string or empty list for fields that do not apply. The application validates it before applying anything. Populate replacementText for edit_selection, or reply for conversation/comment_reply, and always include a short summary. Put standalone document feedback in comments; it is delivered after the run.`;
  const adapt = (text: string) =>
    text
      .replace(/call the submit_response tool exactly once[^\n]*/gi, finishing)
      .replace(/call submit_response[^\n]*/gi, finishing)
      .replace(/submitted via the submit_response tool/gi, "returned in the structured final response")
      .replace(/passed to submit_response/gi, "returned in the structured final response")
      .replace(/on submit_response/gi, "in the structured final response")
      .replace(/PREFER the add_comment tool:[^\n]*/gi, "Put each standalone review comment in the final comments array.");
  return `${adapt(buildSystemPrompt(input))}\n\n${adapt(buildUserPrompt(input))}\n\n${finishing}`;
}

function clip(value: unknown, limit = 1200): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function emit(
  onProgress: CodexResearchAgentOptions["onProgress"],
  event: ClaudeAgentProgressEvent | null
) {
  if (!onProgress || !event?.message.trim()) return;
  void Promise.resolve(onProgress(event)).catch(() => null);
}

// --------------------------------------------------------------- app-server
//
// The app-server protocol carries v2 thread items (camelCase: `commandExecution`,
// `content: string[]`, …). They are mapped onto the same timeline strings the
// client renderer asserts.

type CodexV2Item = Record<string, unknown> & { type?: string; id?: string };

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function codexV2ItemProgress(item: CodexV2Item): ClaudeAgentProgressEvent | null {
  const inProgress = item.status === "inProgress";
  switch (item.type) {
    case "reasoning": {
      const content = Array.isArray(item.content) ? item.content.map(asString) : [];
      const summary = Array.isArray(item.summary) ? item.summary.map(asString) : [];
      const text = [...summary, ...content].filter((part) => part.trim()).join("\n\n");
      return text.trim() ? { role: "agent", message: text } : null;
    }
    case "commandExecution":
      if (inProgress) {
        return { role: "tool", message: `Bash: ${JSON.stringify({ command: asString(item.command) })}` };
      }
      return {
        role: "tool_result",
        message: clip(
          JSON.stringify({
            stdout: asString(item.aggregatedOutput),
            stderr: "",
            exitCode: typeof item.exitCode === "number" ? item.exitCode : null
          })
        )
      };
    case "fileChange":
      return {
        role: "tool",
        message: `Codex file changes: ${JSON.stringify({ status: item.status, changes: item.changes })}`
      };
    case "mcpToolCall": {
      const label = `mcp__${asString(item.server)}__${asString(item.tool)}`;
      if (inProgress) return { role: "tool", message: `${label}: ${clip(item.arguments)}` };
      const error = item.error as { message?: string } | undefined;
      if (error?.message) return { role: "error", message: error.message };
      return { role: "tool_result", message: clip(item.result ?? "completed") };
    }
    case "dynamicToolCall":
    case "collabAgentToolCall": {
      const name = asString(item.tool) || asString(item.name) || "tool";
      return inProgress
        ? { role: "tool", message: `${name}: ${clip(item.arguments ?? item.input ?? {})}` }
        : { role: "tool_result", message: clip(item.result ?? "completed") };
    }
    case "webSearch":
      return { role: "tool", message: `WebSearch: ${JSON.stringify({ query: asString(item.query) })}` };
    case "sleep":
      return { role: "tool", message: `Sleep: ${clip(item.durationMs ?? item.duration ?? "")}` };
    case "contextCompaction":
      return { role: "system", message: "Compacted the conversation context." };
    default:
      // userMessage (including the echo of a steering message), agentMessage,
      // plan, and the review-mode markers have no timeline row of their own.
      return null;
  }
}

const V2_PLAN_STATUS: Record<string, string> = {
  pending: "pending",
  inProgress: "in_progress",
  completed: "completed"
};

/**
 * `turn/plan/updated` carries the whole plan every time, which is exactly the
 * snapshot shape the session plan rail already understands — so it is rendered
 * as a TodoWrite row rather than as a new client-side concept.
 */
export function codexV2PlanProgress(params: Record<string, unknown>): ClaudeAgentProgressEvent | null {
  const plan = Array.isArray(params.plan) ? (params.plan as Record<string, unknown>[]) : [];
  if (plan.length === 0) return null;
  const todos = plan.map((entry) => ({
    content: asString(entry.step),
    status: V2_PLAN_STATUS[asString(entry.status)] ?? "pending"
  }));
  return { role: "tool", message: `TodoWrite: ${clip(JSON.stringify({ todos }))}` };
}

type CodexTurnState = {
  threadId: string;
  activeTurnId: string | null;
  /** Steering messages that arrived while no turn was active. */
  buffered: string[];
  /** A parked turn waits here for the scheduler/user to inject the next turn. */
  parkedResolve: ((text: string) => void) | null;
  parkedReject: ((error: Error) => void) | null;
};

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function completedMcpCallFailed(item: CodexV2Item): boolean {
  if ((item.error as { message?: string } | undefined)?.message) return true;
  return asObject(item.result).isError === true;
}

/**
 * Codex reaches Slack tools through the remote MCP server, unlike Claude's
 * in-process SDK tools. Observe the completed call so lifecycle control is a
 * runtime fact, not something we hope the model remembers after the tool says
 * "end your turn".
 */
function applyCodexRuntimeControl(
  item: CodexV2Item,
  turnPark: TurnPark,
  onProgress: CodexResearchAgentOptions["onProgress"]
): void {
  if (
    item.type !== "mcpToolCall" ||
    asString(item.server) !== "gdocs" ||
    completedMcpCallFailed(item)
  ) {
    return;
  }
  const toolName = asString(item.tool);
  const args = asObject(item.arguments);
  if (toolName === "check_back_later") {
    const minutes = Number(args.after_minutes);
    const kept = turnPark.arm(minutes);
    emit(onProgress, {
      role: "system",
      message: kept
        ? `Codex turn parked: this session stays alive for the check-back wake-up (up to ${MAX_KEEP_ALIVE_MINUTES} minutes).`
        : `Codex check-back scheduled without session parking because the delay exceeds ${MAX_KEEP_ALIVE_MINUTES} minutes.`
    });
    return;
  }
  if (toolName === "keep_alive_after_turn" && typeof args.enabled === "boolean") {
    turnPark.setKeepAlive(args.enabled);
    emit(onProgress, {
      role: "system",
      message: args.enabled
        ? `Keep-alive enabled: the Codex session stays alive after each turn for background work.${
            typeof args.note === "string" && args.note.trim() ? ` Note: ${args.note.trim()}` : ""
          }`
        : "Keep-alive disabled: the Codex session ends normally when the turn finishes."
    });
  }
}

/**
 * Run ONE app-server turn and return the final assistant message.
 *
 * Unlike the exec path (one process per turn, stdin closed immediately), the
 * thread stays alive here, so a message pushed onto options.inputChannel is
 * delivered into THIS turn via `turn/steer` — real parity with Claude.
 */
async function runCodexAppServerTurn(
  client: CodexAppServerClient,
  state: CodexTurnState,
  prompt: string,
  options: CodexResearchAgentOptions,
  onCompletedItem?: (item: CodexV2Item) => void
): Promise<string> {
  let finalResponse = "";
  let settle: ((error: Error | null) => void) | null = null;
  const finished = new Promise<void>((resolve, reject) => {
    settle = (error) => {
      settle = null;
      if (error) reject(error);
      else resolve();
    };
  });
  const done = (error: Error | null) => settle?.(error);

  const unsubscribe = client.onNotification((notification: CodexNotification) => {
    const { method, params } = notification;
    if (method === "thread/started") {
      const thread = params.thread as { id?: string } | undefined;
      if (thread?.id) {
        state.threadId = thread.id;
        if (options.onSessionId) void Promise.resolve(options.onSessionId(thread.id)).catch(() => null);
      }
      return;
    }
    if (params.threadId && params.threadId !== state.threadId) return;
    switch (method) {
      case "turn/started": {
        const turn = params.turn as { id?: string } | undefined;
        if (turn?.id) {
          state.activeTurnId = turn.id;
          flushBufferedSteering(client, state, options);
        }
        return;
      }
      case "turn/plan/updated":
        emit(options.onProgress, codexV2PlanProgress(params));
        return;
      case "item/started":
      case "item/completed": {
        const item = params.item as CodexV2Item | undefined;
        if (!item) return;
        if (item.type === "agentMessage") {
          if (method === "item/completed") finalResponse = asString(item.text);
          return;
        }
        if (method === "item/completed") onCompletedItem?.(item);
        emit(options.onProgress, codexV2ItemProgress(item));
        return;
      }
      case "error": {
        // `willRetry` errors are transient and the server keeps working.
        if (params.willRetry) {
          const retryable = params.error as { message?: string } | undefined;
          emit(options.onProgress, {
            role: "system",
            message: `Codex is retrying after an error: ${retryable?.message ?? "unknown error"}`
          });
          return;
        }
        const error = params.error as { message?: string } | undefined;
        done(new Error(error?.message ?? "Codex reported an error."));
        return;
      }
      case "turn/completed": {
        const turn = params.turn as
          | { id?: string; status?: string; error?: { message?: string } }
          | undefined;
        state.activeTurnId = null;
        if (turn?.status === "failed") {
          done(new Error(turn.error?.message ?? "Codex turn failed."));
          return;
        }
        if (turn?.status === "interrupted") {
          done(new Error("Codex turn was interrupted."));
          return;
        }
        done(null);
        return;
      }
      default:
        return;
    }
  });

  const onAbort = () => {
    if (state.activeTurnId) {
      void client
        .request("turn/interrupt", { threadId: state.threadId, turnId: state.activeTurnId })
        .catch(() => null);
    }
    done(new Error("Codex run was cancelled."));
  };
  if (options.signal?.aborted) {
    unsubscribe();
    throw new Error("Codex run was cancelled.");
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const started = await client.request<{ turn?: { id?: string } }>("turn/start", {
      threadId: state.threadId,
      input: [{ type: "text", text: prompt }],
      outputSchema: CODEX_SUBMISSION_JSON_SCHEMA
    });
    if (started?.turn?.id && !state.activeTurnId) {
      state.activeTurnId = started.turn.id;
      flushBufferedSteering(client, state, options);
    }
    await finished;
    return finalResponse;
  } finally {
    unsubscribe();
    options.signal?.removeEventListener("abort", onAbort);
    state.activeTurnId = null;
  }
}

function flushBufferedSteering(
  client: CodexAppServerClient,
  state: CodexTurnState,
  options: CodexResearchAgentOptions
) {
  if (state.buffered.length === 0) return;
  const pending = state.buffered.splice(0, state.buffered.length);
  for (const text of pending) void deliverSteering(client, state, text, options);
}

/**
 * Deliver one user message into the running turn. `expectedTurnId` is a
 * server-side precondition, so a message that lands just after the turn ended
 * fails cleanly instead of vanishing — the same boundary race the Claude
 * channel has, and it must stay visible in the timeline rather than silent.
 */
async function deliverSteering(
  client: CodexAppServerClient,
  state: CodexTurnState,
  text: string,
  options: CodexResearchAgentOptions
): Promise<void> {
  const expectedTurnId = state.activeTurnId;
  if (!expectedTurnId) {
    if (state.parkedResolve) {
      const resolve = state.parkedResolve;
      state.parkedResolve = null;
      state.parkedReject = null;
      resolve(text);
      return;
    }
    state.buffered.push(text);
    return;
  }
  try {
    await client.request("turn/steer", {
      threadId: state.threadId,
      expectedTurnId,
      input: [{ type: "text", text }]
    });
  } catch (error) {
    emit(options.onProgress, {
      role: "error",
      message: `A message could not be delivered into the running Codex turn: ${
        error instanceof Error ? error.message : String(error)
      }`
    });
  }
}

/** Pump the host's steering channel into `turn/steer` for the run's lifetime. */
function startSteeringPump(
  client: CodexAppServerClient,
  state: CodexTurnState,
  options: CodexResearchAgentOptions
): void {
  const channel = options.inputChannel;
  if (!channel) return;
  void (async () => {
    try {
      for await (const text of channel) {
        await deliverSteering(client, state, text, options);
      }
      state.parkedReject?.(new Error("Codex steering channel closed while the turn was parked."));
    } catch (error) {
      state.parkedReject?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      state.parkedResolve = null;
      state.parkedReject = null;
    }
  })();
}

function waitForParkedInput(
  state: CodexTurnState,
  options: CodexResearchAgentOptions,
  timeoutMs: number
): Promise<string | null> {
  if (state.buffered.length > 0) return Promise.resolve(state.buffered.shift() as string);
  if (!options.inputChannel || options.inputChannel.isClosed()) {
    return Promise.reject(new Error("Codex cannot park without a live steering channel."));
  }
  return new Promise<string | null>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      state.parkedResolve = null;
      state.parkedReject = null;
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("Codex run was cancelled."));
    };
    state.parkedResolve = (text) => {
      cleanup();
      resolve(text);
    };
    state.parkedReject = (error) => {
      cleanup();
      reject(error);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, Math.max(0, timeoutMs));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

async function nextCodexTurnAfterPark(
  turnPark: TurnPark,
  state: CodexTurnState,
  options: CodexResearchAgentOptions
): Promise<string | null> {
  if (turnPark.isArmed()) {
    emit(options.onProgress, {
      role: "system",
      message: "Waiting for the check-back wake-up; the Codex session, container, and background jobs remain alive."
    });
    const message = await waitForParkedInput(state, options, turnPark.remainingMs());
    turnPark.disarm();
    return message ?? PARK_TIMEOUT_NUDGE;
  }
  if (!turnPark.keepAliveEnabled()) return null;
  if (turnPark.keepAliveExpired()) {
    turnPark.setKeepAlive(false);
    return KEEP_ALIVE_EXPIRED_NUDGE;
  }
  emit(options.onProgress, {
    role: "system",
    message: "Codex keep-alive is on; the session, container, and background jobs remain alive after this turn."
  });
  const message = await waitForParkedInput(state, options, KEEP_ALIVE_RECHECK_MS);
  if (message != null) return message;
  if (turnPark.keepAliveExpired()) {
    turnPark.setKeepAlive(false);
    return KEEP_ALIVE_EXPIRED_NUDGE;
  }
  return KEEP_ALIVE_RECHECK_NUDGE;
}

export async function runCodexSubmissionLoop(input: {
  initialPrompt: string;
  runTurn: (prompt: string) => Promise<string>;
  validateSubmission?: ClaudeAgentRunOptions["validateSubmission"];
  onRejected?: (error: string) => void | Promise<void>;
  /** Return a prompt to continue this same session; null accepts the response. */
  nextPromptAfterTurn?: () => Promise<string | null>;
}): Promise<Partial<ClaudeResearchAgentOutput>> {
  let prompt = input.initialPrompt;
  let lastError = "Submission was invalid.";
  let attempt = 0;
  while (attempt < MAX_SUBMISSION_ATTEMPTS) {
    const finalResponse = await input.runTurn(prompt);
    const continuation = await input.nextPromptAfterTurn?.();
    if (continuation != null) {
      prompt = continuation;
      continue;
    }
    attempt += 1;
    let parsed: Partial<ClaudeResearchAgentOutput>;
    try {
      parsed = normalizeSubmittedOutput(JSON.parse(finalResponse));
      lastError = "";
    } catch (error) {
      lastError = `Structured response could not be parsed as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`;
      parsed = {};
    }
    if (!lastError && input.validateSubmission) {
      try {
        lastError = (await input.validateSubmission(parsed)) ?? "";
      } catch (error) {
        lastError = `Submission validation could not be completed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    if (!lastError) return parsed;
    await input.onRejected?.(lastError);
    if (attempt === MAX_SUBMISSION_ATTEMPTS) {
      throw new Error(
        `Codex submission rejected after ${MAX_SUBMISSION_ATTEMPTS} attempts: ${lastError}`
      );
    }
    prompt =
      `Your structured response was rejected by the application:\n${lastError}\n\n` +
      "Correct exactly this issue and return the complete JSON response again. " +
      "For findText anchors, use short distinctive snippets of the document's visible text (matching tolerates newline/whitespace differences and markdown syntax, but the words must be present and unique); if an optional suggestion or comment still cannot be anchored, remove it.";
  }
  throw new Error(`Codex submission rejected: ${lastError}`);
}

export function codexProviderConfig(
  provider: "openai" | "litellm" | "chatgpt",
  env: Record<string, string>,
  input: Pick<ClaudeResearchAgentInput, "slackTools"> | undefined
): { config: CodexConfigObject; baseUrl?: string; apiKey?: string } {
  const config: CodexConfigObject = {
    show_raw_agent_reasoning: false,
    // Codex natively reads only AGENTS.md. Workspaces use CLAUDE.md (the Slack
    // notebook convention, HOST DEV MODE, linked repos), so in any directory
    // that has no AGENTS.md Codex reads CLAUDE.md instead. This is Codex's own
    // per-directory fallback, so nothing is written into the workspace and
    // switching harnesses never changes workspace content.
    project_doc_fallback_filenames: ["CLAUDE.md"],
    ...(input?.slackTools
      ? {
          mcp_servers: {
            gdocs: {
              url: input.slackTools.url,
              http_headers: { Authorization: `Bearer ${input.slackTools.token}` },
              required: true
            },
            ...(input.slackTools.mcpUrl
              ? {
                  rdocs: {
                    url: input.slackTools.mcpUrl,
                    http_headers: { Authorization: `Bearer ${input.slackTools.token}` },
                    required: true
                  }
                }
              : {})
          }
        }
      : {})
  };
  if (provider === "openai") {
    return {
      config,
      baseUrl: env.OPENAI_BASE_URL?.trim() || env.OPENAI_API_BASE?.trim() || undefined,
      apiKey: env.OPENAI_API_KEY?.trim() || undefined
    };
  }
  if (provider === "chatgpt") {
    // ChatGPT-subscription auth: no API key, no base URL. The auth.json blob
    // (CODEX_CHATGPT_AUTH_JSON) is materialized into $CODEX_HOME/auth.json by
    // seedCodexChatgptAuth before the app-server starts.
    if (!env.CODEX_CHATGPT_AUTH_JSON?.trim()) {
      throw new Error(
        "ChatGPT-subscription Codex model selected but CODEX_CHATGPT_AUTH_JSON is not set."
      );
    }
    config.preferred_auth_method = "chatgpt";
    return { config };
  }
  const key = env.LITELLM_API_KEY?.trim();
  const configuredBase = env.LITELLM_BASE_URL?.trim();
  if (!key) throw new Error("Codex LiteLLM model selected but LITELLM_API_KEY is not set.");
  if (!configuredBase) throw new Error("Codex LiteLLM model selected but LITELLM_BASE_URL is not set.");
  const baseUrl = configuredBase.replace(/\/+$/, "");
  config.model_provider = "rdocs_litellm";
  config.model_providers = {
    rdocs_litellm: {
      name: "r-docs LiteLLM",
      base_url: baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`,
      env_key: "LITELLM_API_KEY",
      wire_api: "responses"
    }
  };
  return { config };
}

// ------------------------------------------------- ChatGPT-subscription auth
//
// A chatgpt-provider run authenticates with the user's Codex CLI login
// (~/.codex/auth.json contents) instead of an API key. The blob rides the
// CODEX_CHATGPT_AUTH_JSON env var only as TRANSPORT: it is materialized into
// $CODEX_HOME/auth.json (mode 0600) before the app-server starts and stripped
// from the child env. Codex ROTATES the refresh token when it refreshes, so
// after the run the file is read back and, when changed, handed to
// options.onCodexAuthRefreshed for persistence — never re-seed a later run
// from a stale original blob.

export async function seedCodexChatgptAuth(env: Record<string, string>): Promise<string> {
  const blob = env.CODEX_CHATGPT_AUTH_JSON?.trim();
  if (!blob) {
    throw new Error(
      "ChatGPT-subscription Codex model selected but CODEX_CHATGPT_AUTH_JSON is not set."
    );
  }
  const home = env.CODEX_HOME?.trim();
  if (!home) throw new Error("Codex ChatGPT auth requires CODEX_HOME to be set.");
  await fs.mkdir(home, { recursive: true });
  const authPath = path.join(home, "auth.json");
  await fs.writeFile(authPath, blob, { mode: 0o600 });
  return authPath;
}

export async function collectRefreshedCodexAuth(
  authPath: string,
  seededBlob: string,
  onRefreshed: ((authJson: string) => void | Promise<void>) | undefined
): Promise<void> {
  if (!onRefreshed) return;
  try {
    const current = (await fs.readFile(authPath, "utf8")).trim();
    if (!current || current === seededBlob.trim()) return;
    JSON.parse(current); // only propagate a well-formed file
    await onRefreshed(current);
  } catch {
    // Best-effort: a missing or garbled file just means nothing to persist.
  }
}

/**
 * Fold the provider settings into the free-form `config` the app-server accepts
 * on `thread/start`. There is no `baseUrl`/`apiKey` surface there, so a custom
 * OpenAI base URL becomes a named model provider exactly like the LiteLLM one.
 */
export function codexAppServerThreadConfig(
  provider: { config: CodexConfigObject; baseUrl?: string; apiKey?: string },
  effort?: string | null
): { config: Record<string, unknown>; modelProvider?: string } {
  const config = { ...(provider.config as Record<string, unknown>) };
  if (effort) config.model_reasoning_effort = effort;
  if (provider.baseUrl) {
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    config.model_providers = {
      ...((config.model_providers as Record<string, unknown>) ?? {}),
      rdocs_openai: {
        name: "r-docs OpenAI",
        base_url: baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`,
        env_key: "OPENAI_API_KEY",
        wire_api: "responses"
      }
    };
    config.model_provider = "rdocs_openai";
  }
  return {
    config,
    modelProvider: typeof config.model_provider === "string" ? config.model_provider : undefined
  };
}

export async function runCodexResearchAgent(
  input: ClaudeResearchAgentInput,
  options: CodexResearchAgentOptions = {}
): Promise<ClaudeResearchAgentOutput> {
  if (!input.workspacePath) {
    throw new Error("Codex research agent requires an isolated workspace path.");
  }
  const resolved = resolveCodexAgentConfig(options.agentConfig);
  // CODEX_HOME is pinned to this run's session root, never the host ~/.codex —
  // the CLI would otherwise find the host's auth.json (see resolveAgentConfigDir).
  const agentEnv = applyAgentConfigDirEnv(buildAgentEnv(process.env, options.agentEnv), {
    harness: "codex",
    sessionConfigDir: options.sessionConfigDir,
    runKey: options.runKey
  });
  const provider = codexProviderConfig(resolved.provider, agentEnv, input);
  const { config, modelProvider } = codexAppServerThreadConfig(provider, resolved.effort);
  const env = { ...agentEnv };
  if (provider.apiKey) env.OPENAI_API_KEY = provider.apiKey;
  let chatgptAuth: { path: string; seeded: string } | null = null;
  if (resolved.provider === "chatgpt") {
    const seeded = env.CODEX_CHATGPT_AUTH_JSON ?? "";
    const authPath = await seedCodexChatgptAuth(env);
    chatgptAuth = { path: authPath, seeded };
    // The blob is transport only — never expose it to the agent subprocess,
    // and never mix API-key auth into a subscription run.
    delete env.CODEX_CHATGPT_AUTH_JSON;
    delete env.OPENAI_API_KEY;
  }
  const client = await CodexAppServerClient.start({ env, cwd: input.workspacePath ?? undefined });
  try {
    emit(options.onProgress, { role: "system", message: "Starting Codex research agent." });
    const threadParams = {
      cwd: input.workspacePath,
      sandbox: input.accessMode === "read_only" ? "read-only" : "danger-full-access",
      approvalPolicy: "never",
      model: resolved.model,
      ...(modelProvider ? { modelProvider } : {}),
      config
    };
    // A recorded session id can outlive its rollout file (GC'd, or recorded in
    // a different environment — the host-side planSessionResume check cannot
    // catch every case), and the app-server then rejects thread/resume. That
    // must degrade to a fresh thread with a VISIBLE timeline event, never fail
    // the run and never degrade silently.
    let started: { thread?: { id?: string } } | null = null;
    if (input.resumeSessionId) {
      try {
        started = await client.request<{ thread?: { id?: string } }>("thread/resume", {
          threadId: input.resumeSessionId,
          ...threadParams
        });
      } catch (error) {
        started = null;
        emit(options.onProgress, {
          role: "system",
          message:
            "The previous Codex session could not be resumed (its transcript is no longer available), so this run continues on a fresh session — earlier tool calls and file reads are NOT in context. " +
            `(${error instanceof Error ? error.message : String(error)})`
        });
      }
    }
    if (!started?.thread?.id) {
      started = await client.request<{ thread?: { id?: string } }>("thread/start", threadParams);
    }
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("Codex app-server did not return a thread id.");
    if (options.onSessionId) await options.onSessionId(threadId);

    const state: CodexTurnState = {
      threadId,
      activeTurnId: null,
      buffered: [],
      parkedResolve: null,
      parkedReject: null
    };
    const turnPark = createTurnPark();
    startSteeringPump(client, state, options);

    const parsed = await runCodexSubmissionLoop({
      initialPrompt: codexPrompt(input),
      runTurn: (prompt) =>
        runCodexAppServerTurn(client, state, prompt, options, (item) =>
          applyCodexRuntimeControl(item, turnPark, options.onProgress)
        ),
      nextPromptAfterTurn: () => nextCodexTurnAfterPark(turnPark, state, options),
      validateSubmission: options.validateSubmission,
      onRejected: (error) =>
        emit(options.onProgress, { role: "system", message: submissionRejectedMessage(error) })
    });
    emit(options.onProgress, { role: "system", message: SUBMITTING_FINAL_RESPONSE });
    emit(options.onProgress, { role: "system", message: PREPARING_DOCUMENT_UPDATE });
    return {
      ...parsed,
      images: parsed.images ?? [],
      widgets: parsed.widgets ?? [],
      suggestions: parsed.suggestions ?? [],
      comments: parsed.comments ?? [],
      model: resolved.label
    };
  } finally {
    options.inputChannel?.close();
    client.close();
    if (chatgptAuth) {
      await collectRefreshedCodexAuth(
        chatgptAuth.path,
        chatgptAuth.seeded,
        options.onCodexAuthRefreshed
      );
    }
  }
}

export async function runCodexMergeConflictResolver(input: {
  workspacePath: string;
  commitSha: string;
  model?: string | null;
  agentEnv?: Record<string, string>;
  isolatedRuntime?: boolean;
  /** See ClaudeAgentRunOptions.sessionConfigDir. */
  sessionConfigDir?: string;
}): Promise<void> {
  const resolved = resolveCodexAgentConfig({ model: input.model });
  const agentEnv = applyAgentConfigDirEnv(buildAgentEnv(process.env, input.agentEnv), {
    harness: "codex",
    sessionConfigDir: input.sessionConfigDir,
    runKey: `merge-${input.commitSha}`
  });
  const mergePrompt = `A git merge is in progress in this repository. The commit being merged is ${input.commitSha}.\n\nResolve every conflict in the working tree. Preserve both sides when compatible and make the smallest coherent choice for semantic conflicts. Remove conflict markers, do not commit, then run git status --porcelain and ensure there are no unmerged paths.`;
  const provider = codexProviderConfig(resolved.provider, agentEnv, undefined);
  const { config, modelProvider } = codexAppServerThreadConfig(provider, resolved.effort);
  const env = { ...agentEnv };
  if (provider.apiKey) env.OPENAI_API_KEY = provider.apiKey;
  if (resolved.provider === "chatgpt") {
    await seedCodexChatgptAuth(env);
    delete env.CODEX_CHATGPT_AUTH_JSON;
    delete env.OPENAI_API_KEY;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);
  const client = await CodexAppServerClient.start({ env, cwd: input.workspacePath });
  try {
    const started = await client.request<{ thread?: { id?: string } }>("thread/start", {
      cwd: input.workspacePath,
      sandbox: input.isolatedRuntime ? "danger-full-access" : "workspace-write",
      approvalPolicy: "never",
      model: resolved.model,
      ...(modelProvider ? { modelProvider } : {}),
      config
    });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("Codex app-server did not return a thread id.");
    const state: CodexTurnState = {
      threadId,
      activeTurnId: null,
      buffered: [],
      parkedResolve: null,
      parkedReject: null
    };
    const result = await runCodexAppServerTurn(client, state, mergePrompt, { signal: controller.signal });
    if (!result.trim()) throw new Error("Codex merge conflict resolver returned no result.");
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Codex merge conflict resolution timed out after 300 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    client.close();
  }
}
