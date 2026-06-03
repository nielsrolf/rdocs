import type {
  ClaudeResearchAgentInput,
  ClaudeResearchAgentOutput
} from "@/agent-core";

import type { AgentRunner, AgentRunOptions } from "./index";

// Client for the standalone container runner service. It will serialize the
// AgentJob (input + agentConfig + agentEnv), POST it to RUNNER_URL, stream NDJSON
// progress frames into options.onProgress, round-trip submission validation
// through options.validateSubmission, and return the final output.
//
// Implemented in P2 (local container, bind-mount transport) and P3 (remote,
// git-bundle transport). Until then, selecting it fails loudly rather than
// silently falling back to the unsandboxed in-process path.
export class HttpRunner implements AgentRunner {
  readonly mode = "http" as const;

  async run(
    _input: ClaudeResearchAgentInput,
    _options?: AgentRunOptions
  ): Promise<ClaudeResearchAgentOutput> {
    throw new Error(
      "[agent-runner] HTTP runner is not implemented yet (planned for P2: containerized runner). " +
        "Set AGENT_RUNNER_MODE=inprocess to run the agent in-process."
    );
  }
}
