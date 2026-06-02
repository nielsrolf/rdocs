import {
  runClaudeResearchAgent,
  type ClaudeAgentRunOptions,
  type ClaudeResearchAgentInput,
  type ClaudeResearchAgentOutput
} from "@/agent-core";

import type { AgentRunner } from "./index";

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
    options?: ClaudeAgentRunOptions
  ): Promise<ClaudeResearchAgentOutput> {
    if (!InProcessRunner.warned) {
      InProcessRunner.warned = true;
      console.warn(
        "[agent-runner] mode=inprocess — the agent runs in the server process with no OS sandbox. " +
          "Set AGENT_RUNNER_MODE=http to use the containerized runner."
      );
    }
    return runClaudeResearchAgent(input, options);
  }
}
