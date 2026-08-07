import type { Thread, ThreadItem } from "@openai/codex-sdk";
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

export type CodexResearchAgentOptions = ClaudeAgentRunOptions;
export const MAX_SUBMISSION_ATTEMPTS = SHARED_MAX_SUBMISSION_ATTEMPTS;
type CodexModule = typeof import("@openai/codex-sdk");
type CodexConfigObject = NonNullable<NonNullable<ConstructorParameters<CodexModule["Codex"]>[0]>["config"]>;

// The app/test TypeScript target is CommonJS while @openai/codex-sdk is
// import-only ESM. Keep it off every Claude-only path and preserve a native
// dynamic import here (tsx otherwise rewrites `import()` to `require()`).
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<CodexModule>;
let codexModulePromise: Promise<CodexModule> | null = null;
export function loadCodexSdk() {
  codexModulePromise ??= nativeImport("@openai/codex-sdk");
  return codexModulePromise;
}

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

export function codexItemProgress(item: ThreadItem): ClaudeAgentProgressEvent | null {
  switch (item.type) {
    case "reasoning":
      return item.text.trim() ? { role: "agent", message: item.text } : null;
    case "command_execution":
      if (item.status === "in_progress") {
        return { role: "tool", message: `Bash: ${JSON.stringify({ command: item.command })}` };
      }
      return {
        role: "tool_result",
        message: clip(JSON.stringify({ stdout: item.aggregated_output, stderr: "", exitCode: item.exit_code }))
      };
    case "file_change":
      return {
        role: "tool",
        message: `Codex file changes: ${JSON.stringify({ status: item.status, changes: item.changes })}`
      };
    case "mcp_tool_call":
      return item.status === "in_progress"
        ? { role: "tool", message: `mcp__${item.server}__${item.tool}: ${clip(item.arguments)}` }
        : {
            role: "tool_result",
            message: item.error?.message ?? clip(item.result?.structured_content ?? item.result?.content ?? "completed")
          };
    case "web_search":
      return { role: "tool", message: `WebSearch: ${JSON.stringify({ query: item.query })}` };
    case "todo_list":
      return { role: "tool", message: `TodoWrite: ${JSON.stringify({ todos: item.items })}` };
    case "error":
      return { role: "error", message: item.message };
    case "agent_message":
      return null;
  }
}

function emit(
  onProgress: CodexResearchAgentOptions["onProgress"],
  event: ClaudeAgentProgressEvent | null
) {
  if (!onProgress || !event?.message.trim()) return;
  void Promise.resolve(onProgress(event)).catch(() => null);
}

export async function runCodexSubmissionLoop(input: {
  initialPrompt: string;
  runTurn: (prompt: string) => Promise<string>;
  validateSubmission?: ClaudeAgentRunOptions["validateSubmission"];
  onRejected?: (error: string) => void | Promise<void>;
}): Promise<Partial<ClaudeResearchAgentOutput>> {
  let prompt = input.initialPrompt;
  let lastError = "Submission was invalid.";
  for (let attempt = 1; attempt <= MAX_SUBMISSION_ATTEMPTS; attempt += 1) {
    const finalResponse = await input.runTurn(prompt);
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
      "Use exact verbatim document substrings for findText anchors; if an optional suggestion or comment cannot be anchored exactly, remove it.";
  }
  throw new Error(`Codex submission rejected: ${lastError}`);
}

export function codexProviderConfig(
  provider: "openai" | "litellm",
  env: Record<string, string>,
  input: Pick<ClaudeResearchAgentInput, "slackTools"> | undefined
): { config: CodexConfigObject; baseUrl?: string; apiKey?: string } {
  const config: CodexConfigObject = {
    show_raw_agent_reasoning: false,
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

async function runCodexTurn(
  thread: Thread,
  prompt: string,
  options: CodexResearchAgentOptions
): Promise<string> {
  const streamed = await thread.runStreamed(prompt, {
    outputSchema: CODEX_SUBMISSION_JSON_SCHEMA,
    signal: options.signal
  });
  let finalResponse = "";
  for await (const event of streamed.events) {
    if (event.type === "thread.started" && options.onSessionId) {
      await options.onSessionId(event.thread_id);
      continue;
    }
    if (event.type === "item.started" || event.type === "item.completed") {
      if (event.item.type === "agent_message" && event.type === "item.completed") {
        finalResponse = event.item.text;
      } else if (event.type === "item.started" || event.item.type !== "command_execution") {
        emit(options.onProgress, codexItemProgress(event.item));
      } else {
        emit(options.onProgress, codexItemProgress(event.item));
      }
    } else if (event.type === "turn.failed") {
      throw new Error(event.error.message);
    } else if (event.type === "error") {
      throw new Error(event.message);
    }
  }
  return finalResponse;
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
  const { Codex } = await loadCodexSdk();
  const codex = new Codex({
    env: agentEnv,
    config: provider.config,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {})
  });
  const threadOptions = {
    model: resolved.model,
    workingDirectory: input.workspacePath,
    skipGitRepoCheck: true,
    sandboxMode: (input.accessMode === "read_only" ? "read-only" : "danger-full-access") as
      | "read-only"
      | "danger-full-access",
    approvalPolicy: "never" as const,
    networkAccessEnabled: input.accessMode !== "read_only",
    ...(resolved.effort ? { modelReasoningEffort: resolved.effort } : {})
  };
  const thread = input.resumeSessionId
    ? codex.resumeThread(input.resumeSessionId, threadOptions)
    : codex.startThread(threadOptions);

  emit(options.onProgress, { role: "system", message: "Starting Codex research agent." });
  const parsed = await runCodexSubmissionLoop({
    initialPrompt: codexPrompt(input),
    runTurn: (prompt) => runCodexTurn(thread, prompt, options),
    validateSubmission: options.validateSubmission,
    onRejected: (error) =>
      emit(options.onProgress, { role: "system", message: `Submission rejected: ${error}` })
  });
  emit(options.onProgress, { role: "system", message: "Submitting final response." });
  emit(options.onProgress, { role: "system", message: "Preparing document update." });
  return {
    ...parsed,
    images: parsed.images ?? [],
    widgets: parsed.widgets ?? [],
    suggestions: parsed.suggestions ?? [],
    comments: parsed.comments ?? [],
    model: resolved.label
  };
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
  const provider = codexProviderConfig(resolved.provider, agentEnv, undefined);
  const { Codex } = await loadCodexSdk();
  const codex = new Codex({
    env: agentEnv,
    config: provider.config,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {})
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);
  try {
    const thread = codex.startThread({
      model: resolved.model,
      workingDirectory: input.workspacePath,
      skipGitRepoCheck: true,
      sandboxMode: input.isolatedRuntime ? "danger-full-access" : "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      ...(resolved.effort ? { modelReasoningEffort: resolved.effort } : {})
    });
    const result = await thread.run(
      `A git merge is in progress in this repository. The commit being merged is ${input.commitSha}.\n\nResolve every conflict in the working tree. Preserve both sides when compatible and make the smallest coherent choice for semantic conflicts. Remove conflict markers, do not commit, then run git status --porcelain and ensure there are no unmerged paths.`,
      { signal: controller.signal }
    );
    if (!result.finalResponse.trim()) {
      throw new Error("Codex merge conflict resolver returned no result.");
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Codex merge conflict resolution timed out after 300 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
