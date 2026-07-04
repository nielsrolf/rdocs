import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ClaudeAgentProgressEvent,
  ClaudeResearchAgentInput,
  ClaudeResearchAgentOutput,
  DocumentEnv
} from "@/agent-core";

import { isAuthFailure, isOpenRouterAgentModel, isRetryableAgentError } from "@/agent-core";

import type { AgentRunner, AgentRunOptions, MergeResolveJob } from "./index";
import { toAgentJob } from "./index";
import { buildContainerEnv, buildContainerRunArgs, serializeEnvFile } from "./container-args";
import { HOST_SESSION_EXPIRED_MESSAGE, resolveContainerCredentialEnv } from "./agent-credential";

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
    isOpenRouter: boolean;
    authRetried: boolean;
    transientAttempt: number;
    delaysMs?: number[];
  }
): ContainerFailureDecision {
  const delaysMs = ctx.delaysMs ?? CONTAINER_TRANSIENT_DELAYS_MS;
  if (isAuthFailure(error)) {
    // OpenRouter jobs use a durable API key: re-resolving can't refresh it, so
    // fail fast. Anthropic jobs get exactly one re-resolve-and-retry.
    if (!ctx.isOpenRouter && !ctx.authRetried) {
      return { action: "auth-retry" };
    }
    return {
      action: "auth-fail",
      message:
        `[agent-runner] agent authentication failed (401). ${HOST_SESSION_EXPIRED_MESSAGE} ` +
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
      agentEnv: job.agentEnv,
      agentModel: job.agentConfig?.model,
      onProgress: options?.onProgress
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
    agentEnv?: DocumentEnv;
    agentModel?: string | null;
    onProgress?: AgentRunOptions["onProgress"];
  }): Promise<Record<string, unknown>> {
    const runtime = process.env.AGENT_CONTAINER_RUNTIME || "docker";
    const image = process.env.AGENT_CONTAINER_IMAGE || "gdocs-agent:local";
    const readOnly = process.env.AGENT_CONTAINER_READONLY !== "false";

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gdocs-agent-"));
    const envFile = path.join(tmpDir, "env");
    const isOpenRouter = isOpenRouterAgentModel(opts.agentModel);
    try {
      // (Re-)resolve the credential and rewrite the env-file. Called once up front
      // and again before an auth retry, so a token Claude Code refreshed on the
      // host in the meantime is picked up (the credential is snapshotted into the
      // env-file, not read live by the container).
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
        if (warning) console.warn(`[agent-runner] ${warning}`);
        await writeFile(envFile, serializeEnvFile(containerEnv), { mode: 0o600 });
      };

      const args = buildContainerRunArgs({
        image,
        workspaceHostPath: opts.workspaceHostPath,
        envFileHostPath: envFile,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
        memory: process.env.AGENT_CONTAINER_MEMORY || "4g",
        cpus: process.env.AGENT_CONTAINER_CPUS || undefined,
        pidsLimit: 512,
        readOnly,
        // e.g. AGENT_CONTAINER_OCI_RUNTIME=runsc to run under gVisor (Linux).
        ociRuntime: process.env.AGENT_CONTAINER_OCI_RUNTIME || undefined
      });

      let authRetried = false;
      let transientAttempt = 0;
      for (;;) {
        await prepareEnv();
        try {
          return await this.spawnContainer(runtime, args, opts.job, opts.onProgress);
        } catch (error) {
          const decision = classifyContainerFailure(error, { isOpenRouter, authRetried, transientAttempt });
          if (decision.action === "auth-retry") {
            authRetried = true;
            console.warn(
              "[agent-runner] agent authentication failed (401); re-reading host credentials and retrying once."
            );
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
    onProgress?: AgentRunOptions["onProgress"]
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const child = spawn(runtime, args, { stdio: ["pipe", "pipe", "pipe"] });

      let result: Record<string, unknown> | null = null;
      let frameError: string | null = null;
      let stdoutBuffer = "";
      let stderrTail = "";
      const pending: Array<Promise<unknown>> = [];

      const handleFrame = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let frame: {
          type?: string;
          event?: ClaudeAgentProgressEvent;
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
        if (stdoutBuffer.trim()) handleFrame(stdoutBuffer);
        await Promise.all(pending);
        if (frameError) {
          reject(new Error(frameError));
          return;
        }
        if (result) {
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

      child.stdin.write(JSON.stringify(job));
      child.stdin.end();
    });
  }
}
