import type { ClaudeResearchAgentInput, ClaudeResearchAgentOutput } from "@/agent-core";

import { enqueueSelfHostedJob, getSelfHostedJob } from "@/lib/self-hosted-jobs";

import type { AgentRunner, AgentRunOptions, MergeResolveJob } from "./index";
import { toAgentJob } from "./index";
import { RunCancelledError } from "./run-registry";

// Poll cadence + budget for waiting on an external worker. There is no push
// channel yet (see NOT_DONE below), so this is a plain DB poll — cheap enough
// at this interval, and the caller (the 3 agent routes) is already running in
// a fire-and-forget background task per the async-run architecture, so a slow
// poll loop here does not hold up any HTTP response.
const POLL_INTERVAL_MS = 3_000;
// No Cloudflare-facing timeout applies here (this runs in the 202+poll
// background task, not the request/response cycle), but an abandoned job
// must not poll forever — the run reaper's silence window is the backstop;
// this is a second, generous belt-and-suspenders cap.
const MAX_WAIT_MS = 6 * 60 * 60 * 1000; // 6 hours

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new RunCancelledError());
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new RunCancelledError());
      },
      { once: true }
    );
  });
}

// Enqueues a SelfHostedJob instead of managing a worktree/container, then
// polls the DB for the external worker's result (POST
// /api/self-hosted/jobs/:id/result). Selected per-document via
// getSelfHostedRunner() when Document.runnerMode === "selfHosted" — NOT via
// AGENT_RUNNER_MODE, which is a deployment-wide setting.
//
// NOT DONE YET (explicitly out of scope for this slice — see CLAUDE.md task):
//   - No live progress streaming: options.onProgress/onComment/onSlackMessage
//     never fire for a selfHosted run today. The agent view will show nothing
//     until the job completes. A follow-up could have the worker POST
//     incremental NDJSON-equivalent progress frames the same way the result
//     is posted, and thread them into recordAiRunEvent.
//   - No merge-conflict resolution: resolveMergeConflicts() below throws.
//     Self-hosted docs don't get automatic merge resolution in this slice;
//     the owner's worker would need to handle merges itself, or this needs a
//     dedicated MergeResolveJob queue entry (not built).
//   - No cancellation propagation to the external worker: aborting `signal`
//     stops OUR poll and rejects the run, but nothing tells the worker to stop
//     — it will still complete (or fail) the job, just to no one listening.
export class SelfHostedPullRunner implements AgentRunner {
  readonly mode = "http" as const; // reuses the "http"-shaped job contract; no separate mode enum entry (see index.ts).

  async run(
    input: ClaudeResearchAgentInput,
    options?: AgentRunOptions
  ): Promise<ClaudeResearchAgentOutput> {
    const documentId = options?.documentId;
    const aiRunId = options?.aiRunId;
    if (!documentId || !aiRunId) {
      throw new Error(
        "[agent-runner] selfHostedPull runner requires documentId + aiRunId in AgentRunOptions."
      );
    }

    const job = toAgentJob(input, options);
    const created = await enqueueSelfHostedJob({ documentId, aiRunId, jobPayload: job });

    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      if (options?.signal?.aborted) {
        throw new RunCancelledError();
      }
      const row = await getSelfHostedJob(created.id);
      if (!row) {
        throw new Error(`[agent-runner] self-hosted job ${created.id} vanished while polling.`);
      }
      if (row.status === "succeeded") {
        return JSON.parse(row.resultPayload ?? "{}") as ClaudeResearchAgentOutput;
      }
      if (row.status === "failed") {
        throw new Error(row.error ?? "Self-hosted worker reported a failure with no message.");
      }
      await sleep(POLL_INTERVAL_MS, options?.signal);
    }

    throw new Error(
      `[agent-runner] self-hosted job ${created.id} was not completed by any worker within ` +
        `${Math.round(MAX_WAIT_MS / 60_000)} minutes.`
    );
  }

  async resolveMergeConflicts(_job: MergeResolveJob): Promise<void> {
    throw new Error(
      "[agent-runner] selfHostedPull does not support merge-conflict resolution yet — the " +
        "owner's worker would need to handle merges itself (not built in this slice)."
    );
  }
}
