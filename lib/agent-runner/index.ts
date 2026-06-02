// AgentRunner — the seam between the app and however the Claude Agent SDK loop
// is actually executed. The three agent routes call `getAgentRunner().run(...)`
// instead of invoking the SDK in-process directly, so the execution backend
// (in-process today; a hardened container / remote service next) can be swapped
// without touching the routes' AiRun bookkeeping or post-processing.
//
// run() deliberately mirrors `runClaudeResearchAgent(input, options)`: the
// `input` + `options.agentConfig` + `options.agentEnv` are the serializable
// "job" shipped to a remote runner, while `options.onProgress` /
// `options.validateSubmission` are runtime handlers kept in-process (and bridged
// over the wire by HttpRunner). `toAgentJob` performs that split.

import type {
  ClaudeAgentRunOptions,
  ClaudeResearchAgentInput,
  ClaudeResearchAgentOutput,
  DocumentAgentConfig,
  DocumentEnv
} from "@/agent-core";

import { InProcessRunner } from "./inprocess";
import { HttpRunner } from "./http";

/** The serializable half of an agent run — safe to JSON-encode and ship. */
export type AgentJob = {
  input: ClaudeResearchAgentInput;
  agentConfig?: DocumentAgentConfig;
  agentEnv?: DocumentEnv;
};

/** The non-serializable half — runtime callbacks that stay app-side. */
export type AgentRunHandlers = Pick<ClaudeAgentRunOptions, "onProgress" | "validateSubmission">;

export interface AgentRunner {
  /** Stable identifier of the execution backend, for logging/tests. */
  readonly mode: AgentRunnerMode;
  run(
    input: ClaudeResearchAgentInput,
    options?: ClaudeAgentRunOptions
  ): Promise<ClaudeResearchAgentOutput>;
}

export type AgentRunnerMode = "inprocess" | "http";

/** Split an options bag into the serializable job payload + runtime handlers. */
export function toAgentJob(
  input: ClaudeResearchAgentInput,
  options?: ClaudeAgentRunOptions
): AgentJob {
  return {
    input,
    agentConfig: options?.agentConfig,
    agentEnv: options?.agentEnv
  };
}

export function resolveAgentRunnerMode(
  env: Record<string, string | undefined> = process.env
): AgentRunnerMode {
  const raw = (env.AGENT_RUNNER_MODE ?? "").trim().toLowerCase();
  return raw === "http" ? "http" : "inprocess";
}

export function createAgentRunner(mode: AgentRunnerMode): AgentRunner {
  switch (mode) {
    case "http":
      return new HttpRunner();
    case "inprocess":
    default:
      return new InProcessRunner();
  }
}

let cached: AgentRunner | null = null;

/** Process-wide singleton selected by AGENT_RUNNER_MODE (default inprocess). */
export function getAgentRunner(): AgentRunner {
  if (!cached) {
    cached = createAgentRunner(resolveAgentRunnerMode());
  }
  return cached;
}
