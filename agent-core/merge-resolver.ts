import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { type HookCallback, query } from "@anthropic-ai/claude-agent-sdk";

import { parseMaxTurns } from "./agent-config";
import { type DocumentEnv, buildAgentEnv } from "./agent-env";
import { evaluateToolPathAccess } from "./agent-sandbox";
import { CLAUDE_AGENT_TOOLS } from "./ai-tools";

// Resolves an in-progress git merge in `workspacePath` by letting Claude edit
// the conflicted files. Framework-free so it runs both in-process and inside the
// sandbox container (where workspacePath is the bind-mounted base checkout). Like
// the document agent, it scrubs the env to the allow-list and confines tools to
// the workspace via a deterministic PreToolUse guard — so even the in-process
// path no longer runs with the full host env / unrestricted reads.
//
// Resolves on success; throws on timeout or a hard SDK error.
export async function runMergeConflictResolver(input: {
  workspacePath: string;
  commitSha: string;
  model?: string | null;
  maxTurns?: number;
  agentEnv?: DocumentEnv;
}): Promise<void> {
  const model = input.model || "sonnet";
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 300_000);

  const canonical = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolvePath(p);
    }
  };
  const guardWorkspace = canonical(input.workspacePath);
  const preToolUseGuard: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== "PreToolUse") return {};
    const decision = evaluateToolPathAccess({
      workspace: guardWorkspace,
      protectedRoots: [],
      toolName: hookInput.tool_name,
      toolInput: (hookInput.tool_input ?? null) as Record<string, unknown> | null
    });
    if (decision.allowed) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason
      }
    };
  };

  const prompt = `A git merge is currently in progress in this repository.

The commit being merged is ${input.commitSha}.

Resolve all merge conflicts in the working tree. Preserve both the base branch intent and the incoming AI agent changes whenever they are compatible. If a real semantic conflict exists, make the smallest coherent implementation that keeps the repository buildable.

Do not commit. After editing, run \`git status --porcelain\` and report whether any unmerged paths remain.

Return only JSON:
{"summary":"what you resolved","unresolved":false}
`;

  const mergeQuery = query({
    prompt,
    options: {
      cwd: input.workspacePath,
      systemPrompt:
        "You are resolving git merge conflicts for a collaborative document app. Edit files directly, remove conflict markers, and keep the result coherent. Do not run background processes and do not commit.",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: CLAUDE_AGENT_TOOLS,
      maxTurns: parseMaxTurns(input.maxTurns != null ? String(input.maxTurns) : process.env.CLAUDE_MERGE_MAX_TURNS),
      model,
      thinking: { type: "disabled" },
      env: buildAgentEnv(process.env, input.agentEnv),
      sandbox: { enabled: true, failIfUnavailable: false, autoAllowBashIfSandboxed: true },
      hooks: { PreToolUse: [{ hooks: [preToolUseGuard] }] },
      abortController
    }
  });

  try {
    for await (const message of mergeQuery) {
      if (message.type === "result" && message.is_error) {
        const errors = "errors" in message ? message.errors : ["Claude merge conflict resolution failed."];
        throw new Error(errors.join("\n"));
      }
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error("Claude merge conflict resolution timed out after 300 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    mergeQuery.close();
  }
}
