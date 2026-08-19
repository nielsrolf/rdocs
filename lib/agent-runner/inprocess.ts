import {
  buildSubmissionValidator,
  createAgentInputChannel,
  agentHarnessForModel,
  runClaudeResearchAgent,
  runMergeConflictResolver,
  type ClaudeResearchAgentInput,
  type ClaudeResearchAgentOutput
} from "@/agent-core";
import type { AgentRunner, AgentRunOptions, MergeResolveJob } from "./index";
import {
  RunCancelledError,
  deregisterRunMessageInjector,
  registerRunMessageInjector
} from "./run-registry";

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
    // Steering channel. Both harnesses deliver a message INTO the running turn:
    // Claude via streaming input, Codex via the app-server's turn/steer.
    const harness = agentHarnessForModel(options?.agentConfig?.model);
    const inputChannel = options?.aiRunId ? createAgentInputChannel() : undefined;
    if (inputChannel && options?.aiRunId) {
      registerRunMessageInjector(options.aiRunId, (text) => inputChannel.push(text));
    }
    const runOptions = {
      inputChannel,
      onProgress: options?.onProgress,
      onComment: options?.onComment,
      onSlackMessage: options?.onSlackMessage,
      // Native session/config root. MUST be an app-managed dir: left to its
      // default the harness CLI resolves the HOST's ~/.claude (or ~/.codex),
      // finds the operator's logged-in session, and retries a rejected request
      // with it — a host-credential leak that also fails every brokered run
      // ("Credential broker: Missing or malformed broker token."). The
      // per-conversation dir doubles as the transcript store, so in-process
      // conversations get real session resume too; runs without one fall back
      // to a run-scoped temp dir inside agent-core.
      sessionConfigDir: options?.sessionDirHostPath,
      runKey: options?.aiRunId,
      onSessionId: options?.onSessionId,
      agentConfig: options?.agentConfig,
      agentEnv: options?.agentEnv,
      validateSubmission,
      // Real cancellation: the signal reaches the SDK loop, which tears down
      // its subprocess — without this, "cancelled" runs kept executing.
      signal: options?.signal,
      // Trusted host runs (Slack dev channel) opt out of the workspace guard
      // and kernel sandbox: the whole point is operating on the deployment.
      isolatedRuntime: options?.trustedHostRun === true
    };
    const rawPromise = harness !== "codex"
      ? runClaudeResearchAgent(input, runOptions)
      : import("../../agent-core/codex-agent").then(({ runCodexResearchAgent }) =>
          runCodexResearchAgent(input, runOptions)
        );
    const runPromise = rawPromise.finally(() => {
      inputChannel?.close();
      if (inputChannel && options?.aiRunId) {
        deregisterRunMessageInjector(options.aiRunId);
      }
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

  async resolveMergeConflicts(job: MergeResolveJob): Promise<void> {
    const input = {
      workspacePath: job.workspacePath,
      commitSha: job.commitSha,
      model: job.agentConfig?.model,
      agentEnv: job.agentEnv
    };
    if (agentHarnessForModel(job.agentConfig?.model) === "codex") {
      const { runCodexMergeConflictResolver } = await import("../../agent-core/codex-agent");
      return runCodexMergeConflictResolver(input);
    }
    return runMergeConflictResolver(input);
  }
}
