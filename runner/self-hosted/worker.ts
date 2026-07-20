// Self-hosted worker poll loop. Runs OUTSIDE the app's infrastructure — on
// the document owner's own machine/box — using the owner's own Claude/GitHub
// credentials. It is the pull-side counterpart of
// lib/agent-runner/self-hosted.ts's SelfHostedPullRunner: that side enqueues a
// SelfHostedJob row and polls the DB for a result; this side polls the HTTP
// claim endpoint, executes the job with agent-core (the SAME execution engine
// runner/agent-entrypoint.ts uses inside the app's own container runner), and
// posts the result back.
//
// Protocol (see runner/self-hosted/README.md for the authoritative spec):
//   POST {APP_URL}/api/self-hosted/jobs/claim         -> { job } | { job: null }
//   POST {APP_URL}/api/self-hosted/jobs/:id/result    <- { result } | { error }
//
// IMPORTANT GAP (see README "Explicitly NOT implemented yet"): the job
// payload's `input.workspacePath` always arrives as `null` — the app never
// creates or serializes a git worktree for a selfHosted document, and no repo
// URL/branch/credentials are part of the job payload at all today. This
// worker therefore cannot clone "the document's repo" on its own; see
// resolveWorkspaceDir() below for the (documented, degraded) options it
// actually implements.

import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildSubmissionValidator,
  runClaudeResearchAgent,
  type ClaudeResearchAgentInput,
  type ClaudeResearchAgentOutput
} from "./agent-core/index";

const execFileAsync = promisify(execFile);

const APP_URL = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
const SELF_HOSTED_TOKEN = (process.env.SELF_HOSTED_TOKEN ?? "").trim();
// Optional: a pre-existing local checkout of the document's linked repo. The
// app has no opinion on how this got there (clone it yourself, with whatever
// git credentials you have on this machine) — see the README gap note above.
// If unset, jobs run against an empty scratch directory: no repo tools work,
// but doc-only edits (edit_selection / comment_reply / conversation without
// repo access) still do.
const WORKSPACE_REPO_PATH = process.env.WORKSPACE_REPO_PATH?.trim() || null;
const SCRATCH_ROOT = process.env.WORKER_SCRATCH_DIR?.trim() || os.tmpdir();

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const POLL_BACKOFF_MAX_MS = Number(process.env.POLL_BACKOFF_MAX_MS ?? 30000);

if (!APP_URL) {
  console.error("[self-hosted-worker] APP_URL is required.");
  process.exit(1);
}
if (!SELF_HOSTED_TOKEN) {
  console.error("[self-hosted-worker] SELF_HOSTED_TOKEN is required.");
  process.exit(1);
}

type ClaimedJob = {
  id: string;
  documentId: string;
  aiRunId: string;
  claimedAt: string;
  jobPayload: {
    input: ClaudeResearchAgentInput;
    agentConfig?: Record<string, unknown>;
    agentEnv?: Record<string, string>;
    validation?: Parameters<typeof buildSubmissionValidator>[0];
    /** Repo coordinates; cloned with THIS box's own git credentials. */
    repo?: { url: string; branch: string | null } | null;
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function claimJob(): Promise<ClaimedJob | null> {
  const response = await fetch(`${APP_URL}/api/self-hosted/jobs/claim`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SELF_HOSTED_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`claim failed: ${response.status} ${await response.text().catch(() => "")}`);
  }
  const body = (await response.json()) as { job: ClaimedJob | null };
  return body.job ?? null;
}

type ProgressEvent = { role?: string; message: string };

// Progress frames are batched (the SDK can emit many per second) and posted
// every few seconds. The response doubles as the cancellation channel.
async function postProgress(jobId: string, events: ProgressEvent[]): Promise<{ cancelled: boolean }> {
  const response = await fetch(`${APP_URL}/api/self-hosted/jobs/${jobId}/progress`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SELF_HOSTED_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ events: events.slice(0, 50) })
  });
  if (!response.ok) return { cancelled: false };
  const body = (await response.json().catch(() => null)) as { cancelled?: boolean } | null;
  return { cancelled: body?.cancelled === true };
}

async function postResult(jobId: string, payload: { result: unknown } | { error: string }): Promise<void> {
  const response = await fetch(`${APP_URL}/api/self-hosted/jobs/${jobId}/result`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SELF_HOSTED_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`posting result failed: ${response.status} ${await response.text().catch(() => "")}`);
  }
}

/**
 * Degraded stand-in for the app's worktree bind-mount (see the file-header
 * gap note): produces a fresh scratch directory for this job, optionally
 * seeded from a single pre-configured local checkout (WORKSPACE_REPO_PATH).
 * Copies rather than reusing the checkout in place so a crashed/aborted agent
 * run never leaves the user's real working tree dirty, and so concurrent jobs
 * (were this worker ever run with concurrency > 1) don't collide.
 */
async function resolveWorkspaceDir(
  jobId: string,
  repo: { url: string; branch: string | null } | null | undefined
): Promise<string> {
  const dir = await mkdtemp(path.join(SCRATCH_ROOT, `self-hosted-job-${jobId}-`));
  if (WORKSPACE_REPO_PATH) {
    // `cp -a` preserves a .git dir well enough for the agent's own git
    // commands to operate against a real history. rsync/git-worktree would be
    // more efficient for large repos, but cp keeps this dependency-free.
    await execFileAsync("cp", ["-a", `${WORKSPACE_REPO_PATH}/.`, dir]);
    return dir;
  }
  if (repo?.url) {
    // Clone with whatever git credentials THIS box has (configureGithubAuth
    // ran first when the job carries a token; otherwise ambient credentials).
    const args = ["clone", ...(repo.branch ? ["--branch", repo.branch] : []), repo.url, dir];
    try {
      await execFileAsync("git", args, { timeout: 10 * 60 * 1000 });
      console.error(`[self-hosted-worker] cloned ${repo.url}${repo.branch ? `#${repo.branch}` : ""}`);
    } catch (error) {
      console.error(
        `[self-hosted-worker] clone of ${repo.url} failed (${(error as Error).message}); running with an empty scratch dir`
      );
    }
  }
  return dir;
}

function configureGithubAuth(githubToken: string | undefined) {
  const token = githubToken?.trim();
  if (!token) return;
  try {
    // Mirrors runner/agent-entrypoint.ts: lets plain `git clone/push
    // https://github.com/...` and `gh` pick up the run's resolved token via
    // $HOME/.gitconfig. This worker is NOT sandboxed the way the app's
    // container runner is, so this writes to whatever $HOME actually is on
    // this machine/container — acceptable because the whole point of
    // self-hosting is that this box is already the user's own trusted
    // infrastructure.
    execFileSync("git", [
      "config",
      "--global",
      `url.https://x-access-token:${token}@github.com/.insteadOf`,
      "https://github.com/"
    ]);
  } catch (error) {
    console.error(`[self-hosted-worker] git auth config failed: ${(error as Error).message}`);
  }
}

const PROGRESS_FLUSH_MS = 2_500;

async function runJob(job: ClaimedJob): Promise<void> {
  console.error(`[self-hosted-worker] running job ${job.id} (aiRunId=${job.aiRunId}, documentId=${job.documentId})`);
  configureGithubAuth(job.jobPayload.agentEnv?.GITHUB_TOKEN);
  const workspaceDir = await resolveWorkspaceDir(job.id, job.jobPayload.repo);

  // Live progress: batch frames and flush on an interval. The flush response
  // is also how the app tells us the run was cancelled — abort the SDK loop
  // (kills its subprocess) and drop the job without posting a result.
  const abort = new AbortController();
  let cancelled = false;
  const pendingEvents: ProgressEvent[] = [];
  let flushing = false;
  const flush = async () => {
    if (flushing || pendingEvents.length === 0) return;
    flushing = true;
    const batch = pendingEvents.splice(0, 50);
    try {
      const outcome = await postProgress(job.id, batch);
      if (outcome.cancelled && !cancelled) {
        cancelled = true;
        console.error(`[self-hosted-worker] job ${job.id} was cancelled by the app; aborting`);
        abort.abort();
      }
    } catch (error) {
      console.error(`[self-hosted-worker] progress post failed: ${(error as Error).message}`);
    } finally {
      flushing = false;
    }
  };
  const flushTimer = setInterval(() => {
    void flush();
  }, PROGRESS_FLUSH_MS);

  try {
    const input: ClaudeResearchAgentInput = { ...job.jobPayload.input, workspacePath: workspaceDir };
    const validateSubmission = job.jobPayload.validation
      ? buildSubmissionValidator(job.jobPayload.validation, { workspacePath: workspaceDir })
      : undefined;

    const output: ClaudeResearchAgentOutput = await runClaudeResearchAgent(input, {
      onProgress: (event) => {
        pendingEvents.push({ role: event.role, message: event.message });
      },
      agentConfig: job.jobPayload.agentConfig as never,
      agentEnv: job.jobPayload.agentEnv,
      validateSubmission,
      signal: abort.signal,
      // Not a container: no kernel mount-namespace boundary exists here, so
      // keep the in-process workspace guard enabled (same choice InProcessRunner
      // makes for its own no-sandbox fallback).
      isolatedRuntime: false
    });

    if (cancelled) {
      console.error(`[self-hosted-worker] job ${job.id} finished after cancellation; result discarded`);
      return;
    }
    await flush();
    await postResult(job.id, { result: output });
    console.error(`[self-hosted-worker] job ${job.id} succeeded`);
  } catch (error) {
    if (cancelled) {
      console.error(`[self-hosted-worker] job ${job.id} aborted (cancelled by the app)`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[self-hosted-worker] job ${job.id} failed: ${message}`);
    await postResult(job.id, { error: message }).catch((postError) => {
      console.error(`[self-hosted-worker] failed to report failure for job ${job.id}: ${(postError as Error).message}`);
    });
  } finally {
    clearInterval(flushTimer);
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  console.error(
    `[self-hosted-worker] starting. APP_URL=${APP_URL} workspaceRepoPath=${WORKSPACE_REPO_PATH ?? "(none — empty scratch dir per job)"}`
  );
  let backoffMs = POLL_INTERVAL_MS;
  for (;;) {
    try {
      const job = await claimJob();
      if (!job) {
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, POLL_BACKOFF_MAX_MS);
        continue;
      }
      backoffMs = POLL_INTERVAL_MS;
      await runJob(job);
    } catch (error) {
      console.error(`[self-hosted-worker] poll loop error: ${(error as Error).message}`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, POLL_BACKOFF_MAX_MS);
    }
  }
}

main().catch((error) => {
  console.error(`[self-hosted-worker] fatal: ${(error as Error).message}`);
  process.exit(1);
});
