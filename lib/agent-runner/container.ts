import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ClaudeAgentProgressEvent,
  ClaudeResearchAgentInput,
  ClaudeResearchAgentOutput,
  DocumentEnv
} from "@/agent-core";

import { agentHarnessForModel, agentModelProvider, isAuthFailure, isRetryableAgentError, mergeBufferedComments } from "@/agent-core";

import type { AgentRunner, AgentRunOptions, MergeResolveJob } from "./index";
import { toAgentJob } from "./index";
import {
  buildContainerEnv,
  buildContainerRunArgs,
  resolveContainerPidsLimit,
  resolveContainerUser,
  serializeEnvFile
} from "./container-args";
import {
  CONNECT_ANTHROPIC_CREDENTIAL_MESSAGE,
  CONNECT_OPENAI_CREDENTIAL_MESSAGE,
  resolveContainerCredentialEnv
} from "./agent-credential";
import { agentRunSemaphore } from "./concurrency";
import {
  RunCancelledError,
  deregisterRunMessageInjector,
  registerRunMessageInjector
} from "./run-registry";
import { AGENT_SESSION_PORT } from "@/agent-core/session-protocol";
import {
  createDockerOps,
  generateSessionSecret,
  runDetachedSession,
  sessionSecretEnv,
  SessionAbortedError
} from "./container-session";
import { createAiRunSessionStore, detachedContainersEnabled } from "./session-store";

// Transient container-level failures (spawn / exit-without-result) get one
// bounded backoff retry here. In-agent-loop API errors (429/500/overloaded) are
// retried INSIDE the container by agent-core's runWithTransientRetry; those
// never reach this layer, so the two retry budgets do not stack on the same
// error.
const CONTAINER_TRANSIENT_DELAYS_MS = [2_000, 8_000];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type ContainerFailureDecision =
  | { action: "auth-retry" }
  | { action: "auth-fail"; message: string }
  | { action: "transient-retry"; delayMs: number }
  | { action: "throw" };

// Pure retry policy for a container spawn failure — extracted so it is unit
// testable without spawning docker. State (authRetried / transientAttempt) is
// carried by the caller's loop.
export function classifyContainerFailure(
  error: unknown,
  ctx: {
    /** True for OpenRouter/LiteLLM jobs, which authenticate with a durable provider key. */
    usesProviderKey: boolean;
    harness?: "claude-code" | "codex";
    authRetried: boolean;
    transientAttempt: number;
    delaysMs?: number[];
  }
): ContainerFailureDecision {
  const delaysMs = ctx.delaysMs ?? CONTAINER_TRANSIENT_DELAYS_MS;
  if (isAuthFailure(error)) {
    return {
      action: "auth-fail",
      message:
        ctx.harness === "codex"
          ? `[agent-runner] Codex authentication failed (401). ${CONNECT_OPENAI_CREDENTIAL_MESSAGE} Verify the OpenAI/LiteLLM credential selected for this model. ` +
            `Original error: ${error instanceof Error ? error.message : String(error)}`
          : `[agent-runner] agent authentication failed (401). ${CONNECT_ANTHROPIC_CREDENTIAL_MESSAGE} ` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (isRetryableAgentError(error) && ctx.transientAttempt < delaysMs.length) {
    return { action: "transient-retry", delayMs: delaysMs[ctx.transientAttempt] };
  }
  return { action: "throw" };
}

// Runs the agent in a hardened local container with the relevant worktree
// bind-mounted at /workspace. The agent's tools are confined to the container's
// mount namespace, so the host home / app repo / sibling worktrees are
// unreachable — the real boundary the in-process path lacked.
//
// Transport: the job goes in over stdin; NDJSON frames come back over stdout;
// stderr is forwarded to the server log. Secrets ride a host-side --env-file.
export class ContainerRunner implements AgentRunner {
  readonly mode = "container" as const;

  async run(
    input: ClaudeResearchAgentInput,
    options?: AgentRunOptions
  ): Promise<ClaudeResearchAgentOutput> {
    const job = toAgentJob(input, options);
    if (!job.input.workspacePath) {
      throw new Error(
        "[agent-runner] container mode requires an isolated workspace path; refusing to run without one."
      );
    }
    const output = await this.spawnJob({
      job,
      workspaceHostPath: job.input.workspacePath,
      sessionDirHostPath: options?.sessionDirHostPath,
      agentEnv: job.agentEnv,
      agentModel: job.agentConfig?.model,
      onProgress: options?.onProgress,
      onComment: options?.onComment,
      onSlackMessage: options?.onSlackMessage,
      onSessionId: options?.onSessionId,
      signal: options?.signal,
      containerName: options?.containerName,
      // Steering: lets the host push extra user messages into the live turn
      // over the container's stdin (Claude harness only — see spawnContainer).
      steerRunId: options?.aiRunId,
      // Detached runs record their container handle on this row, which is the
      // whole handover surface between deployments.
      aiRunId: options?.aiRunId
    });
    return output as ClaudeResearchAgentOutput;
  }

  // Resolve an in-progress git merge inside the sandbox (the base checkout is
  // bind-mounted). Closes the last host-side untrusted-code path.
  async resolveMergeConflicts(job: MergeResolveJob): Promise<void> {
    await this.spawnJob({
      job: {
        kind: "merge_resolve",
        commitSha: job.commitSha,
        agentConfig: job.agentConfig,
        agentEnv: job.agentEnv
      },
      workspaceHostPath: job.workspacePath,
      agentEnv: job.agentEnv,
      agentModel: job.agentConfig?.model
    });
  }

  private async spawnJob(opts: {
    job: unknown;
    workspaceHostPath: string;
    sessionDirHostPath?: string;
    agentEnv?: DocumentEnv;
    agentModel?: string | null;
    onProgress?: AgentRunOptions["onProgress"];
    onComment?: AgentRunOptions["onComment"];
    onSlackMessage?: AgentRunOptions["onSlackMessage"];
    onSessionId?: AgentRunOptions["onSessionId"];
    signal?: AbortSignal;
    containerName?: string;
    steerRunId?: string;
    aiRunId?: string;
  }): Promise<Record<string, unknown>> {
    const runtime = process.env.AGENT_CONTAINER_RUNTIME || "docker";
    const harness = agentHarnessForModel(opts.agentModel);
    const image = harness === "codex"
      ? process.env.CODEX_AGENT_CONTAINER_IMAGE || "gdocs-codex-agent:local"
      : process.env.AGENT_CONTAINER_IMAGE || "gdocs-agent:local";
    const readOnly = process.env.AGENT_CONTAINER_READONLY !== "false";

    // Concurrency cap: runs beyond AGENT_MAX_CONCURRENT_RUNS queue here (FIFO)
    // instead of piling containers onto the docker VM. The slot is held across
    // the auth/transient retries below — a retry is the same run, not a new one.
    const semaphore = agentRunSemaphore();
    if (semaphore.activeCount >= semaphore.limit && opts.onProgress) {
      await Promise.resolve(
        opts.onProgress({
          role: "system",
          message: `Queued: all ${semaphore.limit} agent slots are busy (position ${semaphore.queuedCount + 1} in queue).`
        })
      ).catch(() => {});
    }
    let releaseSlot: () => void;
    try {
      releaseSlot = await semaphore.acquire(opts.signal);
    } catch (error) {
      if (opts.signal?.aborted) throw new RunCancelledError();
      throw error;
    }
    try {
      return await this.spawnJobWithSlot(opts, { runtime, image, readOnly });
    } finally {
      releaseSlot();
    }
  }

  private async spawnJobWithSlot(
    opts: Parameters<ContainerRunner["spawnJob"]>[0],
    ctx: { runtime: string; image: string; readOnly: boolean }
  ): Promise<Record<string, unknown>> {
    const { runtime, image, readOnly } = ctx;
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gdocs-agent-"));
    const envFile = path.join(tmpDir, "env");
    const harness = agentHarnessForModel(opts.agentModel);
    const provider = agentModelProvider(opts.agentModel);
    const usesProviderKey = provider !== "anthropic";
    const sessionDirHostPath = harness === "codex"
      ? opts.sessionDirHostPath ?? path.join(tmpDir, "codex-home")
      : opts.sessionDirHostPath;
    // Detached session transport: the container outlives this process (see
    // container-session.ts). The secret rides the env file, never the argv.
    const detached = detachedContainersEnabled(process.env);
    const sessionSecret = detached ? generateSessionSecret() : undefined;
    // Both harnesses deliver a message INTO the live turn: Claude via streaming
    // input, Codex via the app-server's turn/steer.
    const steerRunId = opts.steerRunId;
    try {
      if (harness === "codex") {
        await mkdir(sessionDirHostPath!, { recursive: true });
        // Older builds copied the host login into conversation storage. Remove
        // that credential artifact without touching Codex's native rollouts.
        await rm(path.join(sessionDirHostPath!, "auth.json"), { force: true });
      }
      // Validate the already-resolved document/account credential and write the
      // isolated env file. Host credential files are never read or mounted.
      const prepareEnv = async () => {
        const containerEnv = buildContainerEnv(process.env, opts.agentEnv ?? {});
        const { added, warning, error } = resolveContainerCredentialEnv(containerEnv, opts.agentModel, {
          homeDir: process.env.HOME
        });
        // Freshness gate: never ship a credential that is already unusable.
        if (error) {
          throw new Error(`[agent-runner] ${error}`);
        }
        Object.assign(containerEnv, added);
        if (sessionSecret) Object.assign(containerEnv, sessionSecretEnv(sessionSecret));
        if (warning) console.warn(`[agent-runner] ${warning}`);
        await writeFile(envFile, serializeEnvFile(containerEnv), { mode: 0o600 });
      };

      const containerUser = resolveContainerUser(process.platform, process.getuid?.(), process.getgid?.());
      const args = buildContainerRunArgs({
        image,
        name: opts.containerName,
        workspaceHostPath: opts.workspaceHostPath,
        sessionDirHostPath,
        agentHarness: harness,
        envFileHostPath: envFile,
        ...containerUser,
        memory: process.env.AGENT_CONTAINER_MEMORY || "4g",
        cpus: process.env.AGENT_CONTAINER_CPUS || undefined,
        pidsLimit: resolveContainerPidsLimit(process.env),
        readOnly,
        // e.g. AGENT_CONTAINER_OCI_RUNTIME=runsc to run under gVisor (Linux).
        ociRuntime: process.env.AGENT_CONTAINER_OCI_RUNTIME || undefined,
        detached,
        sessionPort: detached ? AGENT_SESSION_PORT : undefined,
        sessionSecret
      });

      let authRetried = false;
      let transientAttempt = 0;
      for (;;) {
        if (opts.signal?.aborted) {
          throw new RunCancelledError();
        }
        await prepareEnv();
        try {
          if (detached && sessionSecret) {
            // The container is nobody's child: it is recorded, then driven over
            // HTTP, and it holds its result until we have persisted it.
            return await runDetachedSession({
              docker: createDockerOps(runtime),
              args,
              containerPort: AGENT_SESSION_PORT,
              secret: sessionSecret,
              job: opts.job,
              signal: opts.signal,
              steerRunId: steerRunId,
              store: createAiRunSessionStore(opts.aiRunId),
              sink: {
                onProgress: opts.onProgress,
                onComment: opts.onComment,
                onSlackMessage: opts.onSlackMessage,
                onSessionId: opts.onSessionId
              }
            });
          }
          return await this.spawnContainer(runtime, args, opts.job, opts.onProgress, opts.onComment, opts.onSlackMessage, {
            signal: opts.signal,
            containerName: opts.containerName,
            onSessionId: opts.onSessionId,
            steerRunId: steerRunId
          });
        } catch (error) {
          // A cancelled session reports itself; the loop below must not treat it
          // as a transient container failure and start a second container.
          if (error instanceof SessionAbortedError) {
            throw new RunCancelledError();
          }
          // A killed container manifests as "exited without a result" — never
          // classify a cancellation as transient and retry it.
          if (opts.signal?.aborted) {
            throw new RunCancelledError();
          }
          const decision = classifyContainerFailure(error, { harness, usesProviderKey, authRetried, transientAttempt });
          if (decision.action === "auth-retry") {
            authRetried = true;
            continue;
          }
          if (decision.action === "auth-fail") {
            throw new Error(decision.message);
          }
          if (decision.action === "transient-retry") {
            transientAttempt += 1;
            console.warn(
              `[agent-runner] transient container failure (attempt ${transientAttempt}); retrying in ${Math.round(
                decision.delayMs / 1000
              )}s: ${error instanceof Error ? error.message : String(error)}`
            );
            if (detached && opts.containerName) {
              // `--name` is single-use: a still-exiting predecessor would make
              // the retry fail with "name already in use", which is NOT
              // retryable and would surface as an opaque run failure.
              await createDockerOps(runtime).remove(opts.containerName).catch(() => {});
            }
            await sleep(decision.delayMs);
            continue;
          }
          throw error;
        }
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private spawnContainer(
    runtime: string,
    args: string[],
    job: unknown,
    onProgress?: AgentRunOptions["onProgress"],
    onComment?: AgentRunOptions["onComment"],
    onSlackMessage?: AgentRunOptions["onSlackMessage"],
    cancel?: {
      signal?: AbortSignal;
      containerName?: string;
      onSessionId?: AgentRunOptions["onSessionId"];
      /** AiRun id to register a live-steering injector for (Claude harness only). */
      steerRunId?: string;
    }
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const child = spawn(runtime, args, { stdio: ["pipe", "pipe", "pipe"] });

      // Cancellation: SIGTERM the docker client (which proxies the signal into
      // the container) and, when the container is named, `docker kill` it too —
      // deterministic even if the client process is wedged. The close handler
      // then settles the promise; the spawnJob loop turns it into
      // RunCancelledError because the signal is aborted.
      const onAbort = () => {
        child.kill("SIGTERM");
        if (cancel?.containerName) {
          const killer = spawn(runtime, ["kill", "--signal", "KILL", cancel.containerName], {
            stdio: "ignore",
            detached: true
          });
          killer.on("error", () => {});
          killer.unref();
        }
      };
      if (cancel?.signal) {
        if (cancel.signal.aborted) {
          onAbort();
        } else {
          cancel.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      // Live steering: a user message pushed while the turn is running is
      // written into the container as a "user_message" frame. Returns false
      // once stdin is gone (container exiting) so the caller queues instead.
      if (cancel?.steerRunId) {
        registerRunMessageInjector(cancel.steerRunId, (text) => {
          if (!child.stdin.writable || child.stdin.destroyed) return false;
          return child.stdin.write(JSON.stringify({ type: "user_message", text }) + "\n") || true;
        });
      }

      let result: Record<string, unknown> | null = null;
      let frameError: string | null = null;
      let stdoutBuffer = "";
      let stderrTail = "";
      const pending: Array<Promise<unknown>> = [];
      // Comment frames arriving when the caller supplied no onComment handler
      // are merged into the final output.comments instead of being dropped.
      const bufferedComments: Array<{ findText: string; body: string }> = [];

      const handleFrame = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let frame: {
          type?: string;
          event?: ClaudeAgentProgressEvent;
          comment?: { findText?: unknown; body?: unknown };
          text?: unknown;
          sessionId?: unknown;
          output?: Record<string, unknown>;
          message?: string;
        };
        try {
          frame = JSON.parse(trimmed);
        } catch {
          process.stderr.write(`[agent-container] non-JSON stdout: ${trimmed}\n`);
          return;
        }
        if (frame.type === "progress" && frame.event && onProgress) {
          pending.push(Promise.resolve(onProgress(frame.event)).catch(() => {}));
        } else if (
          frame.type === "comment" &&
          typeof frame.comment?.findText === "string" &&
          typeof frame.comment?.body === "string"
        ) {
          const comment = { findText: frame.comment.findText, body: frame.comment.body };
          if (onComment) {
            pending.push(Promise.resolve(onComment(comment)).catch(() => {}));
          } else {
            bufferedComments.push(comment);
          }
        } else if (frame.type === "slack_message" && typeof frame.text === "string") {
          // Interim Slack updates are only meaningful mid-run — dropped (with a
          // note) when the caller has no handler, never buffered.
          if (onSlackMessage) {
            pending.push(Promise.resolve(onSlackMessage(frame.text)).catch(() => {}));
          } else {
            process.stderr.write("[agent-container] dropped slack_message frame (no handler)\n");
          }
        } else if (frame.type === "session" && typeof frame.sessionId === "string" && frame.sessionId) {
          // SDK session id — the host persists it for follow-up session resume.
          if (cancel?.onSessionId) {
            pending.push(Promise.resolve(cancel.onSessionId(frame.sessionId)).catch(() => {}));
          }
        } else if (frame.type === "result" && frame.output) {
          result = frame.output;
        } else if (frame.type === "error") {
          frameError = frame.message ?? "Agent container reported an error.";
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        let nl: number;
        while ((nl = stdoutBuffer.indexOf("\n")) >= 0) {
          handleFrame(stdoutBuffer.slice(0, nl));
          stdoutBuffer = stdoutBuffer.slice(nl + 1);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-4000);
        process.stderr.write(`[agent-container] ${text}`);
      });

      // "container spawn failed" is a recognized transient signal
      // (isRetryableAgentError) — a missing/slow container runtime is worth a
      // retry rather than an opaque terminal failure.
      child.on("error", (error) =>
        reject(new Error(`agent container spawn failed: ${error instanceof Error ? error.message : String(error)}`))
      );

      child.on("close", async (code) => {
        cancel?.signal?.removeEventListener("abort", onAbort);
        if (cancel?.steerRunId) deregisterRunMessageInjector(cancel.steerRunId);
        if (stdoutBuffer.trim()) handleFrame(stdoutBuffer);
        await Promise.all(pending);
        if (frameError) {
          reject(new Error(frameError));
          return;
        }
        if (result) {
          if (bufferedComments.length > 0) {
            const submitted = Array.isArray(result.comments)
              ? (result.comments as Array<{ findText: string; body: string }>)
              : [];
            result.comments = mergeBufferedComments(submitted, bufferedComments);
          }
          resolve(result);
          return;
        }
        // "container exited without a result" is also a recognized transient
        // signal — an OOM-killed or crashed container is often worth one retry.
        reject(
          new Error(
            `agent container exited without a result (exit code ${code}).` +
              (stderrTail ? ` Last stderr:\n${stderrTail}` : "")
          )
        );
      });

      // Job frame first. stdin then stays OPEN for the life of the container so
      // steering messages can be written as further NDJSON frames; the
      // entrypoint parses stdin line by line and exits on its own when the run
      // finishes (it no longer waits for stdin to end).
      child.stdin.on("error", () => {});
      child.stdin.write(JSON.stringify(job) + "\n");
    });
  }
}
