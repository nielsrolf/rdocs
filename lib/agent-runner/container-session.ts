// Host side of a DETACHED agent session container.
//
// The piped path in container.ts makes the container a child process of Next:
// when the app is replaced (blue/green deploy) or crashes, the run dies with it,
// and everything we built to paper over that — the 120-minute keep-alive park
// cap, the drain that waits for in-flight runs, "not owned by the current server
// process" cancel errors — exists only because of that parent/child coupling.
//
// Here the container is started with `docker run -d` and serves the session HTTP
// API instead (agent-core/session-server.ts). The app becomes a stateless
// READER: it persists four things (container id, endpoint, secret, frame cursor)
// and can be replaced at any moment. A newer process attaches to the same live
// container, replays from the cursor, and keeps going.
//
// Two rules this module exists to enforce:
//   1. PERSIST BEFORE YOU START WORK. The endpoint/secret are written before the
//      job is posted, so there is no window where a container is running and
//      nothing in the database knows how to reach or reap it.
//   2. RELEASE ONLY AFTER THE RESULT IS SAFE. The container holds its terminal
//      frame until `POST /release`, so a crash between "agent finished" and
//      "host persisted the outcome" loses nothing — the next attach collects it.

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";

import { mergeBufferedComments } from "@/agent-core";
import {
  AGENT_SESSION_SECRET_ENV,
  type AgentSessionFrame
} from "@/agent-core/session-protocol";

import type { AgentRunOptions } from "./index";
import {
  AttachSupersededError,
  consumeAgentSession,
  createAgentSessionClient,
  type AgentSessionClient
} from "./session-client";
import { deregisterRunMessageInjector, registerRunMessageInjector } from "./run-registry";

export function generateSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionSecretEnv(secret: string): Record<string, string> {
  // Rides the --env-file, never the argv (see buildContainerRunArgs).
  return { [AGENT_SESSION_SECRET_ENV]: secret };
}

/** The docker verbs the detached path needs. Injected so it is testable without Docker. */
export type DetachedDockerOps = {
  /** `docker run -d …` → container id. */
  start(args: string[]): Promise<string>;
  /** `docker port <id> <containerPort>/tcp` → published host port. */
  hostPort(containerId: string, containerPort: number): Promise<number>;
  /** `docker rm -f` — only for containers we are abandoning, not for normal exits. */
  remove(containerId: string): Promise<void>;
};

export function createDockerOps(runtime: string): DetachedDockerOps {
  const run = (args: string[], timeoutMs = 60_000) =>
    new Promise<string>((resolve, reject) => {
      execFile(runtime, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`agent container spawn failed: ${runtime} ${args[0]}: ${stderr.trim() || error.message}`));
          return;
        }
        resolve(stdout.trim());
      });
    });
  return {
    async start(args) {
      const id = await run(args);
      // `docker run -d` prints the id and nothing else; anything else means the
      // engine is confused and we should not proceed to attach.
      const containerId = id.split(/\s+/).pop() ?? "";
      if (!/^[0-9a-f]{12,64}$/i.test(containerId)) {
        throw new Error(`agent container spawn failed: unexpected id from ${runtime} run -d: ${id.slice(0, 200)}`);
      }
      return containerId;
    },
    async hostPort(containerId, containerPort) {
      const raw = await run(["port", containerId, `${containerPort}/tcp`], 15_000);
      // e.g. "127.0.0.1:53422" (possibly several lines for v4/v6).
      for (const line of raw.split("\n")) {
        const match = /:(\d+)\s*$/.exec(line.trim());
        if (match) return Number(match[1]);
      }
      throw new Error(`agent container spawn failed: no published host port for ${containerPort}/tcp`);
    },
    async remove(containerId) {
      await run(["rm", "-f", containerId], 30_000).catch(() => "");
    }
  };
}

export type SessionFrameSink = {
  onProgress?: AgentRunOptions["onProgress"];
  onComment?: AgentRunOptions["onComment"];
  onSlackMessage?: AgentRunOptions["onSlackMessage"];
  onSessionId?: AgentRunOptions["onSessionId"];
};

/**
 * Applies one frame to the host-side handlers. Same frame vocabulary as the
 * piped path, so the two transports are interchangeable from the caller's view.
 * Comments arriving with no handler are buffered into the final output rather
 * than dropped (matching the piped behaviour).
 */
export function createFrameApplier(sink: SessionFrameSink) {
  const bufferedComments: Array<{ findText: string; body: string }> = [];
  const apply = async (frame: AgentSessionFrame) => {
    if (frame.type === "progress" && frame.event) {
      await Promise.resolve(sink.onProgress?.(frame.event as never)).catch(() => {});
      return;
    }
    if (frame.type === "comment") {
      const comment = frame.comment as { findText?: unknown; body?: unknown } | undefined;
      if (typeof comment?.findText !== "string" || typeof comment?.body !== "string") return;
      const value = { findText: comment.findText, body: comment.body };
      if (sink.onComment) {
        await Promise.resolve(sink.onComment(value)).catch(() => {});
      } else {
        bufferedComments.push(value);
      }
      return;
    }
    if (frame.type === "slack_message" && typeof frame.text === "string") {
      if (sink.onSlackMessage) {
        await Promise.resolve(sink.onSlackMessage(frame.text)).catch(() => {});
      } else {
        process.stderr.write("[agent-session] dropped slack_message frame (no handler)\n");
      }
      return;
    }
    if (frame.type === "session" && typeof frame.sessionId === "string" && frame.sessionId) {
      await Promise.resolve(sink.onSessionId?.(frame.sessionId)).catch(() => {});
    }
    // result/error are terminal and handled by consumeAgentSession's outcome.
  };
  return {
    apply,
    /** Fold comments we had nowhere to put into the run's output. */
    finalize(output: Record<string, unknown>) {
      if (bufferedComments.length === 0) return output;
      const submitted = Array.isArray(output.comments)
        ? (output.comments as Array<{ findText: string; body: string }>)
        : [];
      output.comments = mergeBufferedComments(submitted, bufferedComments);
      return output;
    }
  };
}

export type DetachedSessionHandle = {
  containerId: string;
  endpoint: string;
  secret: string;
};

/** Persistence hooks — in production these write the AiRun row. */
export type DetachedSessionStore = {
  /**
   * Called BEFORE the job is posted, with everything needed to find, resume and
   * reap this container. If this throws, the container is removed again: an
   * unrecorded running container is exactly the "nobody knows what is running"
   * failure this design is meant to end.
   */
  onStarted?: (handle: DetachedSessionHandle) => Promise<void> | void;
  /** Called as frames are persisted, so a re-attach never replays them. */
  onCursor?: (cursor: number) => Promise<void> | void;
  /** Called once the container has been released (or abandoned). */
  onFinished?: (handle: DetachedSessionHandle) => Promise<void> | void;
};

export type DetachedSessionOptions = {
  docker: DetachedDockerOps;
  /** Full `docker` argv including `run -d`, `-p` and the image. */
  args: string[];
  /** In-container session port (must match the published mapping in args). */
  containerPort: number;
  secret: string;
  job: unknown;
  sink?: SessionFrameSink;
  store?: DetachedSessionStore;
  signal?: AbortSignal;
  /** AiRun id to register a cross-process steering injector for. */
  steerRunId?: string;
  waitMs?: number;
  /** How long to wait for the in-container HTTP server to bind (0 = no wait). */
  readyTimeoutMs?: number;
  readyPollMs?: number;
  clientFactory?: (baseUrl: string, secret: string) => AgentSessionClient;
};

/**
 * Start a detached container, hand it the job, and drive it to its terminal
 * frame. Returns the run output. The container is released (and thus exits) once
 * the outcome is in hand.
 */
export async function runDetachedSession(
  options: DetachedSessionOptions
): Promise<Record<string, unknown>> {
  const containerId = await options.docker.start(options.args);
  let handle: DetachedSessionHandle;
  try {
    const hostPort = await options.docker.hostPort(containerId, options.containerPort);
    handle = {
      containerId,
      endpoint: `http://127.0.0.1:${hostPort}`,
      secret: options.secret
    };
    await options.store?.onStarted?.(handle);
  } catch (error) {
    // Nothing durable references this container yet, so it must not survive.
    await options.docker.remove(containerId).catch(() => {});
    throw error;
  }

  return await attachDetachedSession({
    handle,
    job: options.job,
    since: 0,
    docker: options.docker,
    sink: options.sink,
    store: options.store,
    signal: options.signal,
    steerRunId: options.steerRunId,
    waitMs: options.waitMs,
    // A freshly started container has published its port but may not have bound
    // its HTTP server yet; attaching immediately used to fail the whole run with
    // "fetch failed" while the container was perfectly healthy.
    readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    readyPollMs: options.readyPollMs,
    clientFactory: options.clientFactory
  });
}

/** Fresh containers pull an image layer cache, mount the workspace, boot Node. */
export const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_READY_POLL_MS = 500;

/**
 * Poll `/status` until the container answers. Startup errors are expected and
 * retried; only the deadline (or an abort) gives up. Uses the probe form so a
 * container we are about to drive is not credited with contact it did not have.
 */
async function waitForSessionReady(
  client: AgentSessionClient,
  timeoutMs: number,
  pollMs: number,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    if (signal?.aborted) return;
    try {
      await client.status(true);
      return;
    } catch (error) {
      if (error instanceof AttachSupersededError) throw error;
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

export type AttachDetachedOptions = {
  handle: DetachedSessionHandle;
  /** Posted only if the container has not accepted a job yet (i.e. a fresh start). */
  job?: unknown;
  /** Frame cursor already persisted; frames at or below it are not replayed. */
  since: number;
  docker?: DetachedDockerOps;
  sink?: SessionFrameSink;
  store?: DetachedSessionStore;
  signal?: AbortSignal;
  steerRunId?: string;
  waitMs?: number;
  /**
   * Wait this long for the container to answer before attaching. Only the
   * fresh-start path sets it: adoption must NOT block on an unreachable
   * container — an unreachable one is the reaper's business.
   */
  readyTimeoutMs?: number;
  readyPollMs?: number;
  clientFactory?: (baseUrl: string, secret: string) => AgentSessionClient;
};

/**
 * Attach to an EXISTING session container and drive it to completion. This is
 * both the tail of a fresh start and the whole of the adoption path: a process
 * that did not start the run resumes it with nothing but the persisted handle
 * and cursor.
 */
export async function attachDetachedSession(
  options: AttachDetachedOptions
): Promise<Record<string, unknown>> {
  const { handle } = options;
  const client = (options.clientFactory ?? defaultClientFactory)(handle.endpoint, handle.secret);
  const applier = createFrameApplier(options.sink ?? {});
  let released = false;

  if ((options.readyTimeoutMs ?? 0) > 0) {
    await waitForSessionReady(
      client,
      options.readyTimeoutMs as number,
      options.readyPollMs ?? DEFAULT_READY_POLL_MS,
      options.signal
    );
  }

  // Taking the attach token invalidates any other process's — the container
  // itself arbitrates ownership, so there is no lease to go stale in the DB and
  // no split brain to reconcile.
  await client.attach();

  if (options.job !== undefined) {
    // False means the container already has a job: this is a resume, and posting
    // again must never start a second agent turn.
    await client.postJob(options.job);
  }

  // Cancellation is in-container now: a detached container has no parent to
  // signal, and an aborted SDK loop still gets to emit its terminal frame.
  const onAbort = () => void client.cancel().catch(() => {});
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  // Steering works from ANY process holding the handle — this is what removes
  // the "run not owned by the current server process" class of failure.
  if (options.steerRunId) {
    registerRunMessageInjector(options.steerRunId, (text) => {
      void client.message(text).catch(() => false);
      // Optimistic: the HTTP round trip outlives this synchronous callback. An
      // undeliverable message is reported by the container and logged there.
      return true;
    });
  }

  try {
    const outcome = await consumeAgentSession({
      client,
      since: options.since,
      waitMs: options.waitMs,
      signal: options.signal,
      onFrame: applier.apply,
      onCursor: (cursor) => options.store?.onCursor?.(cursor)
    });

    if (outcome.kind === "result") {
      // Only now is the outcome ours; releasing lets the container exit.
      await client.release();
      released = true;
      return applier.finalize(outcome.output);
    }
    if (outcome.kind === "error") {
      await client.release();
      released = true;
      throw new Error(outcome.message);
    }
    // Aborted: the cancel above already told the container to stop. It will emit
    // its terminal frame and expire on its own TTL if nobody collects it.
    throw new SessionAbortedError();
  } catch (error) {
    if (error instanceof AttachSupersededError) {
      // Another process owns this run now. Leave the container alone — walking
      // away is correct; killing it would destroy live work.
      throw error;
    }
    throw error;
  } finally {
    if (options.steerRunId) deregisterRunMessageInjector(options.steerRunId);
    options.signal?.removeEventListener("abort", onAbort);
    if (released) {
      await options.store?.onFinished?.(handle);
    }
  }
}

export class SessionAbortedError extends Error {
  constructor() {
    super("Agent session was cancelled.");
    this.name = "SessionAbortedError";
  }
}

function defaultClientFactory(baseUrl: string, secret: string): AgentSessionClient {
  return createAgentSessionClient({ baseUrl, secret });
}
