// Durable app runner: runs agent jobs inside a workspace's ONE long-lived
// container (see lib/durable-apps.ts for the mode itself).
//
// Compared to the per-run ContainerRunner:
//   - the container is looked up by name and reused; it is (re)created only
//     when missing or unreachable (`docker run --rm -d` with the same profile
//     builder, plus the published app port and AGENT_SESSION_DURABLE=1)
//   - the BASE workspace is bind-mounted directly (no per-run clone), so an app
//     the agent started keeps running between sessions and the next session
//     can restart it
//   - the whole sessions root of the workspace document is mounted at
//     /agent-sessions and each job names its own subdirectory
//     (`job.sessionConfigDir`), because one container serves many conversations
//   - jobs are serialized per container: the session server accepts a new job
//     only once the previous one is terminal, so a busy container makes the
//     next run wait (in-process mutex + remote phase poll)
//
// The AiRun still gets the detached-session handle (containerId /
// sessionEndpoint / sessionSecret / frameCursor), so boot adoption, the reaper
// and cancellation work unchanged. The container's own handle lives on the
// DurableApp row.

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AGENT_SESSION_PORT } from "@/agent-core/session-protocol";
import type { ClaudeResearchAgentInput, ClaudeResearchAgentOutput } from "@/agent-core/agent";
import { agentHarnessForModel } from "@/agent-core/agent-config";
import { db } from "@/lib/db";
import type { DurableRunTarget } from "@/lib/durable-apps";
import { buildRunPermalink } from "@/lib/request-origin";

import { resolveContainerCredentialEnv } from "./agent-credential";
import { buildContainerEnv, buildContainerRunArgs, resolveContainerUser, serializeEnvFile } from "./container-args";
import { detectInnerDockerProfile } from "./container";
import { RunCancelledError } from "./run-registry";
import {
  attachDetachedSession,
  createDockerOps,
  DurableJobRejectedError,
  generateSessionSecret,
  SessionAbortedError,
  sessionSecretEnv,
  type DetachedDockerOps,
  type DetachedSessionHandle
} from "./container-session";
import { createAgentSessionClient, type AgentSessionClient } from "./session-client";
import { createAiRunSessionStore } from "./session-store";
import { type AgentRunner, type AgentRunOptions, type MergeResolveJob, getAgentRunner, toAgentJob } from "./index";

export const CONTAINER_SESSIONS_ROOT = "/agent-sessions";
/** How long a run waits for the durable container to finish another session. */
const BUSY_WAIT_MAX_MS = 60 * 60_000;
const BUSY_POLL_MS = 2_000;

export type DurableRunnerDeps = {
  docker?: DetachedDockerOps;
  clientFactory?: (baseUrl: string, secret: string) => AgentSessionClient;
  /** Persist/load the container handle (defaults to the DurableApp row). */
  handleStore?: {
    load(workspaceDocumentId: string): Promise<DetachedSessionHandle | null>;
    save(workspaceDocumentId: string, handle: DetachedSessionHandle | null): Promise<void>;
  };
  now?: () => number;
  busyWaitMaxMs?: number;
  busyPollMs?: number;
  readyTimeoutMs?: number;
  /** Test seam: skip docker probing and use these args verbatim. */
  buildArgs?: typeof buildContainerRunArgs;
};

export type DurableRunnerTarget = DurableRunTarget & {
  /** Host path of the workspace document's sessions root (mounted whole). */
  sessionsRootHostPath: string;
};

/**
 * Container path of a job's harness config dir. Conversation session dirs of
 * the workspace document live under the mounted root; a run from a document
 * that merely SHARES this workspace has its sessions elsewhere on the host, so
 * it gets a durable-owned directory under the root instead (its transcripts
 * then live there, which is fine — only that document's runs read them).
 */
export function containerSessionConfigDir(
  sessionsRootHostPath: string,
  sessionDirHostPath: string | undefined,
  fallbackKey: string
): { container: string; host: string } {
  if (sessionDirHostPath) {
    const rel = path.relative(sessionsRootHostPath, sessionDirHostPath);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return { container: path.posix.join(CONTAINER_SESSIONS_ROOT, rel.split(path.sep).join("/")), host: sessionDirHostPath };
    }
  }
  const key = `shared-${fallbackKey.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80)}`;
  return { container: path.posix.join(CONTAINER_SESSIONS_ROOT, key), host: path.join(sessionsRootHostPath, key) };
}

const defaultHandleStore: NonNullable<DurableRunnerDeps["handleStore"]> = {
  async load(workspaceDocumentId) {
    const row = await db.durableApp.findUnique({
      where: { documentId: workspaceDocumentId },
      select: { containerId: true, sessionEndpoint: true, sessionSecret: true }
    });
    if (!row?.containerId || !row.sessionEndpoint || !row.sessionSecret) return null;
    return { containerId: row.containerId, endpoint: row.sessionEndpoint, secret: row.sessionSecret };
  },
  async save(workspaceDocumentId, handle) {
    await db.durableApp.update({
      where: { documentId: workspaceDocumentId },
      data: handle
        ? { containerId: handle.containerId, sessionEndpoint: handle.endpoint, sessionSecret: handle.secret, startedAt: new Date() }
        : { containerId: null, sessionEndpoint: null, sessionSecret: null, startedAt: null }
    });
  }
};

// Per-container in-process queue. Same globalThis rule as the run registry:
// instrumentation.ts and route handlers must share it.
const QUEUE_KEY = "__gdocsDurableContainerQueues";
function containerQueue(): Map<string, Promise<unknown>> {
  const g = globalThis as unknown as Record<string, Map<string, Promise<unknown>> | undefined>;
  if (!g[QUEUE_KEY]) g[QUEUE_KEY] = new Map();
  return g[QUEUE_KEY]!;
}

async function withContainerQueue<T>(name: string, task: () => Promise<T>): Promise<T> {
  const queue = containerQueue();
  const previous = queue.get(name) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  queue.set(name, run);
  try {
    return await run;
  } finally {
    if (queue.get(name) === run) queue.delete(name);
  }
}

export class DurableContainerRunner implements AgentRunner {
  readonly mode = "container" as const;

  constructor(
    private readonly target: DurableRunnerTarget,
    private readonly deps: DurableRunnerDeps = {}
  ) {}

  async run(input: ClaudeResearchAgentInput, options?: AgentRunOptions): Promise<ClaudeResearchAgentOutput> {
    const job = toAgentJob(input, options);
    if (!job.input.workspacePath) {
      throw new Error("[durable-app] refusing to run without a workspace path.");
    }
    if (agentHarnessForModel(job.agentConfig?.model) === "codex") {
      throw new Error(
        "[durable-app] durable app containers run the Claude agent image; select a Claude/OpenRouter/LiteLLM model for this workspace or turn the durable app off."
      );
    }
    const workspaceHostPath = job.input.workspacePath;
    const runtime = process.env.AGENT_CONTAINER_RUNTIME || "docker";
    const docker = this.deps.docker ?? createDockerOps(runtime);

    // Credential freshness gate — same as the per-run container path. The
    // resolved per-job env rides `job.agentEnv` (the entrypoint merges it into
    // the harness env); the container env file holds only host-derived config.
    const jobEnv = buildContainerEnv(process.env, job.agentEnv ?? {});
    const { added, warning, error } = resolveContainerCredentialEnv(jobEnv, job.agentConfig?.model, {
      homeDir: process.env.HOME
    });
    if (error) throw new Error(`[agent-runner] ${error}`);
    if (warning) console.warn(`[agent-runner] ${warning}`);
    const agentEnv: Record<string, string> = { ...(job.agentEnv ?? {}), ...added };

    const session = containerSessionConfigDir(
      this.target.sessionsRootHostPath,
      options?.sessionDirHostPath,
      options?.documentId ?? "run"
    );
    await mkdir(session.host, { recursive: true });

    // Run identity (GDOCS_RUN_ID / GDOCS_DOCUMENT_ID / GDOCS_RUN_URL) is container
    // env on the one-shot path; here the container is shared, so it rides the
    // job's agent env instead (merged into the harness env by the entrypoint).
    if (options?.aiRunId) agentEnv.GDOCS_RUN_ID = options.aiRunId;
    if (options?.documentId) agentEnv.GDOCS_DOCUMENT_ID = options.documentId;
    const runUrl =
      options?.aiRunId && options?.documentId ? buildRunPermalink(options.documentId, options.aiRunId) : null;
    if (runUrl) agentEnv.GDOCS_RUN_URL = runUrl;

    const containerJob = { ...job, agentEnv, sessionConfigDir: session.container };

    return (await withContainerQueue(this.target.containerName, async () => {
      const busyWaitMax = this.deps.busyWaitMaxMs ?? BUSY_WAIT_MAX_MS;
      const deadline = (this.deps.now ?? Date.now)() + busyWaitMax;
      let announcedBusy = false;
      for (;;) {
        if (options?.signal?.aborted) throw new RunCancelledError();
        const handle = await this.ensureContainer(docker, workspaceHostPath);
        const client = (this.deps.clientFactory ?? defaultClientFactory)(handle.endpoint, handle.secret);

        // Another server process (blue/green sibling) may be driving a job in
        // this container right now. Attaching would steal its reader, so wait
        // for the remote phase to leave "running" first.
        const status = await client.status(true);
        if (status.phase === "running") {
          if (!announcedBusy && options?.onProgress) {
            announcedBusy = true;
            await Promise.resolve(
              options.onProgress({
                role: "system",
                message: "Queued: the workspace's durable app container is busy with another agent session."
              })
            ).catch(() => {});
          }
          if ((this.deps.now ?? Date.now)() >= deadline) {
            throw new Error("[durable-app] the durable app container stayed busy for too long; giving up.");
          }
          await sleep(this.deps.busyPollMs ?? BUSY_POLL_MS, options?.signal);
          continue;
        }

        const store = createAiRunSessionStore(options?.aiRunId);
        await store.onStarted?.(handle);
        try {
          return await attachDetachedSession({
            handle,
            job: containerJob,
            // Frames of earlier jobs stay in the log; start after them.
            since: status.lastSeq,
            requireJobAccepted: true,
            docker,
            store,
            signal: options?.signal,
            steerRunId: options?.aiRunId,
            readyTimeoutMs: this.deps.readyTimeoutMs,
            clientFactory: this.deps.clientFactory,
            sink: {
              onProgress: options?.onProgress,
              onComment: options?.onComment,
              onSlackMessage: options?.onSlackMessage,
              onSessionId: options?.onSessionId,
              onCodexAuthRefreshed: options?.onCodexAuthRefreshed
            }
          });
        } catch (error) {
          if (error instanceof DurableJobRejectedError) {
            // Lost the race against another process: wait and retry.
            await store.onFinished?.(handle);
            await sleep(this.deps.busyPollMs ?? BUSY_POLL_MS, options?.signal);
            continue;
          }
          if (error instanceof SessionAbortedError) throw new RunCancelledError();
          throw error;
        }
      }
    })) as ClaudeResearchAgentOutput;
  }

  // Merge conflicts of the base checkout are resolved by a regular one-shot
  // container (the base workspace is a plain bind mount either way).
  async resolveMergeConflicts(job: MergeResolveJob): Promise<void> {
    await getAgentRunner().resolveMergeConflicts(job);
  }

  /** Reuse the running container when it answers; otherwise (re)create it. */
  private async ensureContainer(docker: DetachedDockerOps, workspaceHostPath: string): Promise<DetachedSessionHandle> {
    const store = this.deps.handleStore ?? defaultHandleStore;
    const known = await store.load(this.target.workspaceDocumentId);
    if (known) {
      const client = (this.deps.clientFactory ?? defaultClientFactory)(known.endpoint, known.secret);
      const alive = await client
        .status(true)
        .then((status) => status.durable === true)
        .catch(() => false);
      if (alive) return known;
      console.warn(`[durable-app] container ${this.target.containerName} is not answering; recreating it`);
    }

    // Whatever is left under that name is dead or foreign to our records.
    await docker.remove(this.target.containerName).catch(() => {});
    await store.save(this.target.workspaceDocumentId, null);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gdocs-durable-"));
    const envFile = path.join(tmpDir, "env");
    try {
      const secret = generateSessionSecret();
      const containerEnv = { ...buildContainerEnv(process.env, {}), ...sessionSecretEnv(secret) };
      await writeFile(envFile, serializeEnvFile(containerEnv), { mode: 0o600 });

      const runtime = process.env.AGENT_CONTAINER_RUNTIME || "docker";
      const explicitOciRuntime = process.env.AGENT_CONTAINER_OCI_RUNTIME || undefined;
      const innerDocker =
        explicitOciRuntime || !this.target.innerDocker ? undefined : await detectInnerDockerProfile(runtime);
      const publicUrl = this.target.hostname ? `https://${this.target.hostname}` : null;
      const extraEnv: Record<string, string> = {
        GDOCS_APP_PORT: String(this.target.appPort),
        GDOCS_WORKSPACE_DOCUMENT_ID: this.target.workspaceDocumentId
      };
      if (this.target.hostname) extraEnv.GDOCS_APP_HOSTNAME = this.target.hostname;
      if (publicUrl) extraEnv.GDOCS_APP_URL = publicUrl;

      const args = (this.deps.buildArgs ?? buildContainerRunArgs)({
        image: process.env.AGENT_CONTAINER_IMAGE || "gdocs-agent:local",
        name: this.target.containerName,
        workspaceHostPath,
        sessionDirHostPath: this.target.sessionsRootHostPath,
        agentHarness: "claude-code",
        envFileHostPath: envFile,
        ...resolveContainerUser(process.platform, process.getuid?.(), process.getgid?.()),
        // A durable container hosts a build + a server + the agent: give it
        // more room than a one-shot run by default.
        memory: process.env.DURABLE_APP_CONTAINER_MEMORY || process.env.AGENT_CONTAINER_MEMORY || "8g",
        cpus: process.env.AGENT_CONTAINER_CPUS || undefined,
        pidsLimit: Number(process.env.DURABLE_APP_PIDS_LIMIT || 2048),
        readOnly: process.env.AGENT_CONTAINER_READONLY !== "false",
        ociRuntime: explicitOciRuntime,
        innerDocker,
        innerDockerTmpfsSize: process.env.AGENT_INNER_DOCKER_TMPFS_SIZE || undefined,
        detached: true,
        durable: true,
        sessionPort: AGENT_SESSION_PORT,
        sessionSecret: secret,
        publishPorts:
          this.target.hostPort !== null ? [{ hostPort: this.target.hostPort, containerPort: this.target.appPort }] : [],
        extraEnv
      });

      const containerId = await docker.start(args);
      try {
        const hostPort = await docker.hostPort(containerId, AGENT_SESSION_PORT);
        const handle = { containerId, endpoint: `http://127.0.0.1:${hostPort}`, secret };
        await store.save(this.target.workspaceDocumentId, handle);
        return handle;
      } catch (error) {
        await docker.remove(containerId).catch(() => {});
        throw error;
      }
    } finally {
      // docker has read the env file at `run`; nothing else may.
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function defaultClientFactory(baseUrl: string, secret: string): AgentSessionClient {
  return createAgentSessionClient({ baseUrl, secret });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RunCancelledError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RunCancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
