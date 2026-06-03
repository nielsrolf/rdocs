import type {
  ClaudeResearchAgentInput,
  ClaudeResearchAgentOutput
} from "@/agent-core";

import type { AgentRunner, AgentRunOptions, MergeResolveJob } from "./index";

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
    throw new Error(HttpRunner.NOT_IMPLEMENTED);
  }

  async resolveMergeConflicts(_job: MergeResolveJob): Promise<void> {
    throw new Error(HttpRunner.NOT_IMPLEMENTED);
  }

  private static readonly NOT_IMPLEMENTED =
    "[agent-runner] HTTP runner is not implemented yet (planned for P3: remote runner service). " +
    "Set AGENT_RUNNER_MODE=inprocess or container.";
}
