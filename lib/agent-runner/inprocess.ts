import {
  buildSubmissionValidator,
  runClaudeResearchAgent,
  runMergeConflictResolver,
  type ClaudeResearchAgentInput,
  type ClaudeResearchAgentOutput
} from "@/agent-core";

import type { AgentRunner, AgentRunOptions, MergeResolveJob } from "./index";
import { RunCancelledError } from "./run-registry";

// Runs the agent loop IN THE SERVER PROCESS — today's behavior. This provides
// NO OS-level sandbox: the agent's Bash/Read/Write tools run as subprocesses of
// the Next.js server with full host access. It is the dev/no-Docker fallback
// only; production should select AGENT_RUNNER_MODE=http once the container
// runner is available. The deterministic PreToolUse guard in agent-core is the
// only confinement here, and it is best-effort defense-in-depth, not a boundary.
export class InProcessRunner implements AgentRunner {
  readonly mode = "inprocess" as const;

  private static warned = false;

  run(
    input: ClaudeResearchAgentInput,
    options?: AgentRunOptions
  ): Promise<ClaudeResearchAgentOutput> {
    if (!InProcessRunner.warned) {
      InProcessRunner.warned = true;
      console.warn(
        "[agent-runner] mode=inprocess — the agent runs in the server process with no OS sandbox. " +
          "Set AGENT_RUNNER_MODE=http to use the containerized runner."
      );
    }
    const validateSubmission = options?.validation
      ? buildSubmissionValidator(options.validation, { workspacePath: input.workspacePath })
      : undefined;
    const runPromise = runClaudeResearchAgent(input, {
      onProgress: options?.onProgress,
      onComment: options?.onComment,
      onSlackMessage: options?.onSlackMessage,
      agentConfig: options?.agentConfig,
      agentEnv: options?.agentEnv,
      validateSubmission
    });
    const signal = options?.signal;
    if (!signal) {
      return runPromise;
    }
    // Best-effort cancellation for the dev-only in-process backend: settle the
    // run promise immediately so the route's bookkeeping proceeds. The SDK loop
    // itself is not torn down (no OS boundary to kill) — it finishes orphaned.
    // The container backend is the one that kills the actual execution.
    return new Promise<ClaudeResearchAgentOutput>((resolve, reject) => {
      const onAbort = () => reject(new RunCancelledError());
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      runPromise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  resolveMergeConflicts(job: MergeResolveJob): Promise<void> {
    return runMergeConflictResolver({
      workspacePath: job.workspacePath,
      commitSha: job.commitSha,
      model: job.agentConfig?.model,
      agentEnv: job.agentEnv
    });
  }
}
