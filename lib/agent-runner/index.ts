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
  DocumentEnv,
  SubmissionValidationSpec
} from "@/agent-core";

import { InProcessRunner } from "./inprocess";
import { ContainerRunner } from "./container";
import { HttpRunner } from "./http";

// run() options. Unlike ClaudeAgentRunOptions, validation is expressed as a
// SERIALIZABLE spec rather than a closure, so it can be shipped to a remote
// runner and reconstructed there. onProgress stays a runtime callback (bridged
// over the wire by HttpRunner).
export type AgentRunOptions = {
  onProgress?: ClaudeAgentRunOptions["onProgress"];
  // Live mid-run comment delivery (see ClaudeAgentRunOptions.onComment).
  // Runtime-only — never shipped as part of the serialized job.
  onComment?: ClaudeAgentRunOptions["onComment"];
  validation?: SubmissionValidationSpec;
  agentConfig?: DocumentAgentConfig;
  agentEnv?: DocumentEnv;
  // Cancellation. Aborting the signal must terminate the run promptly; backends
  // reject with RunCancelledError (see run-registry.ts). Runtime-only — never
  // shipped as part of the serialized job.
  signal?: AbortSignal;
  // Backend hint: a stable name for the execution unit (the docker container),
  // so cancellation can kill it deterministically. Ignored by non-container
  // backends.
  containerName?: string;
};

/** The serializable half of an agent run — safe to JSON-encode and ship. */
export type AgentJob = {
  input: ClaudeResearchAgentInput;
  agentConfig?: DocumentAgentConfig;
  agentEnv?: DocumentEnv;
  validation?: SubmissionValidationSpec;
};

// A git-merge-conflict resolution turn — a different, simpler agent than a
// document turn (no submit_response), run wherever the backend runs.
export type MergeResolveJob = {
  /** Host path of the base checkout with an in-progress merge. */
  workspacePath: string;
  commitSha: string;
  agentConfig?: { model?: string | null };
  agentEnv?: DocumentEnv;
};

export interface AgentRunner {
  /** Stable identifier of the execution backend, for logging/tests. */
  readonly mode: AgentRunnerMode;
  run(
    input: ClaudeResearchAgentInput,
    options?: AgentRunOptions
  ): Promise<ClaudeResearchAgentOutput>;
  /** Resolve an in-progress git merge in the given workspace (resolves on success). */
  resolveMergeConflicts(job: MergeResolveJob): Promise<void>;
}

// inprocess: run in the server process (no OS sandbox; dev fallback).
// container: spawn a hardened local container, worktree bind-mounted (P2).
// http:      POST to a remote runner service (P3).
export type AgentRunnerMode = "inprocess" | "container" | "http";

/** Extract the serializable job payload from an options bag (drops onProgress). */
export function toAgentJob(
  input: ClaudeResearchAgentInput,
  options?: AgentRunOptions
): AgentJob {
  return {
    input,
    agentConfig: options?.agentConfig,
    agentEnv: options?.agentEnv,
    validation: options?.validation
  };
}

export function resolveAgentRunnerMode(
  env: Record<string, string | undefined> = process.env
): AgentRunnerMode {
  const raw = (env.AGENT_RUNNER_MODE ?? "").trim().toLowerCase();
  if (raw === "http") return "http";
  if (raw === "container") return "container";
  return "inprocess";
}

export function createAgentRunner(mode: AgentRunnerMode): AgentRunner {
  switch (mode) {
    case "http":
      return new HttpRunner();
    case "container":
      return new ContainerRunner();
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
