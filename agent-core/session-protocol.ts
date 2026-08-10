// Long-lived agent session protocol — shared by the container session server
// (runner/agent-session-server.ts) and the host session client
// (lib/agent-runner/session-client.ts).
//
// WHY THIS EXISTS
// ---------------
// The original container transport WAS the process tree: `docker run -i --rm`
// as a child of the Next.js app, joined by stdio pipes (job on stdin line 1,
// NDJSON frames on stdout). That makes the run's lifetime a strict subset of
// the app process's lifetime: a blue/green deploy either waits for every run
// (DRAIN_MAX_MS) or kills it, a run is only cancellable/steerable from the one
// process holding the pipe, and a parked turn could not outlive the drain
// window — which is exactly why MAX_KEEP_ALIVE_MINUTES had to be capped at 120.
//
// So the container becomes a DETACHED SESSION SERVER and the app becomes a
// stateless client with a cursor:
//
//   * the container is started with `docker run -d` and owns the durable state:
//     the job, an append-only sequenced frame log, and the terminal outcome;
//   * the app attaches over HTTP on 127.0.0.1 (an ephemeral published port,
//     discovered with `docker port`) and replays frames from `since=<cursor>`;
//   * any process can attach — including a NEWER deployment — so steering,
//     cancellation and result collection are no longer process-local.
//
// Transport decisions worth not relitigating:
//   * TCP on 127.0.0.1, not a Unix socket in a bind mount. Unix sockets across
//     Docker Desktop's virtiofs/gRPC-FUSE mounts are unreliable on macOS.
//   * app -> container, never container -> app. The app's own address changes
//     across a blue/green swap; the container's does not.
//   * single-attach arbitration lives HERE, in the container, as an attach
//     token: whoever attaches last wins and every earlier token is dead. A DB
//     lease would need a second source of truth and could split-brain against
//     the container's actual reader.
//
// This module is pure state + types (no I/O, injectable clock) so both sides
// and the tests share one implementation of the tricky parts: sequencing,
// replay, attach epochs, and the TTLs that replace parent-death as the garbage
// collector.

/** Port the session server listens on INSIDE the container. */
export const AGENT_SESSION_PORT = 8787;
/** Bearer secret, generated per container and shipped in the --env-file. */
export const AGENT_SESSION_SECRET_ENV = "AGENT_SESSION_SECRET";
/** Presence of this env var switches the entrypoint into session-server mode. */
export const AGENT_SESSION_PORT_ENV = "AGENT_SESSION_PORT";
/** Header carrying the attach token issued by POST /attach. */
export const ATTACH_TOKEN_HEADER = "x-agent-attach";

/**
 * No authorized request for this long and the container self-destructs. This
 * replaces "the parent process died" as the collector: nobody is coming for
 * the result, so the work is worthless. Deploy gaps are seconds; a long-poll
 * counts as contact, so an actively-watched run never trips it.
 */
export const DEFAULT_NO_CONTACT_TTL_MS = 30 * 60_000;
/** How long a finished session holds its result waiting to be collected. */
export const DEFAULT_TERMINAL_HOLD_MS = 15 * 60_000;
/** Absolute ceiling on a container's life, whatever the contact pattern. */
export const DEFAULT_MAX_LIFETIME_MS = 26 * 60 * 60_000;
/** Frames kept for replay. Older frames are dropped and reported as a gap. */
export const DEFAULT_FRAME_LOG_LIMIT = 5_000;

export type AgentSessionFrameBody = {
  type: "progress" | "comment" | "slack_message" | "session" | "result" | "error";
  [key: string]: unknown;
};

export type AgentSessionFrame = AgentSessionFrameBody & { seq: number };

export type AgentSessionPhase = "awaiting_job" | "running" | "terminal";

export type AgentSessionStatus = {
  phase: AgentSessionPhase;
  /** Highest sequence number assigned so far (0 = nothing emitted yet). */
  lastSeq: number;
  /** Lowest sequence number still replayable; > 1 means older frames were dropped. */
  firstSeq: number;
  attachEpoch: number;
  startedAtMs: number;
  lastContactAtMs: number;
  finishedAtMs: number | null;
};

export type AttachResponse = AgentSessionStatus & { token: string };

export type FramesResponse = {
  frames: AgentSessionFrame[];
  nextSeq: number;
  /** True once the terminal frame has been assigned a sequence number. */
  done: boolean;
  /**
   * Set when the requested cursor is older than the oldest retained frame.
   * The host must record the gap rather than silently skipping events.
   */
  droppedBefore?: number;
};

export type SessionExitReason = "released" | "no-contact" | "terminal-hold" | "max-lifetime";

export type AgentSessionState = {
  status(): AgentSessionStatus;
  /** Issue a fresh attach token, invalidating any previous one. */
  attach(): AttachResponse;
  /** False when `token` is not the current one (a superseded reader must stop). */
  isCurrentToken(token: string | null | undefined): boolean;
  /** Record host contact; keeps the no-contact TTL from firing. */
  touch(): void;
  /**
   * Accept the job. Returns false if a job was already accepted — a re-attach
   * after a deploy must resume the existing run, never start a second one.
   */
  acceptJob(job: unknown): boolean;
  job(): unknown;
  /** Append a frame and assign it the next sequence number. */
  append(frame: AgentSessionFrameBody): AgentSessionFrame;
  framesSince(seq: number): FramesResponse;
  /** True once a `result` or `error` frame has been appended. */
  isTerminal(): boolean;
  /** Which TTL (if any) says this container should exit now. */
  expiredReason(): SessionExitReason | null;
};

export function createAgentSessionState(options?: {
  now?: () => number;
  frameLimit?: number;
  noContactTtlMs?: number;
  terminalHoldMs?: number;
  maxLifetimeMs?: number;
  newToken?: () => string;
}): AgentSessionState {
  const now = options?.now ?? (() => Date.now());
  const frameLimit = Math.max(1, options?.frameLimit ?? DEFAULT_FRAME_LOG_LIMIT);
  const noContactTtlMs = options?.noContactTtlMs ?? DEFAULT_NO_CONTACT_TTL_MS;
  const terminalHoldMs = options?.terminalHoldMs ?? DEFAULT_TERMINAL_HOLD_MS;
  const maxLifetimeMs = options?.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
  const newToken = options?.newToken ?? defaultTokenFactory();

  const startedAtMs = now();
  let lastContactAtMs = startedAtMs;
  let finishedAtMs: number | null = null;
  let attachEpoch = 0;
  let currentToken: string | null = null;
  let jobValue: unknown = undefined;
  let hasJob = false;
  let lastSeq = 0;
  let firstSeq = 1;
  let terminal = false;
  const frames: AgentSessionFrame[] = [];

  const status = (): AgentSessionStatus => ({
    phase: terminal ? "terminal" : hasJob ? "running" : "awaiting_job",
    lastSeq,
    firstSeq,
    attachEpoch,
    startedAtMs,
    lastContactAtMs,
    finishedAtMs
  });

  return {
    status,
    attach() {
      attachEpoch += 1;
      currentToken = newToken();
      lastContactAtMs = now();
      return { ...status(), token: currentToken };
    },
    isCurrentToken(token) {
      return typeof token === "string" && token.length > 0 && token === currentToken;
    },
    touch() {
      lastContactAtMs = now();
    },
    acceptJob(job) {
      if (hasJob) return false;
      hasJob = true;
      jobValue = job;
      lastContactAtMs = now();
      return true;
    },
    job() {
      return jobValue;
    },
    append(frame) {
      lastSeq += 1;
      const sequenced = { ...frame, seq: lastSeq } as AgentSessionFrame;
      frames.push(sequenced);
      while (frames.length > frameLimit) {
        frames.shift();
        firstSeq = frames[0]?.seq ?? lastSeq;
      }
      if (frame.type === "result" || frame.type === "error") {
        terminal = true;
        finishedAtMs = now();
      }
      return sequenced;
    },
    framesSince(seq) {
      const from = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
      const out = frames.filter((f) => f.seq > from);
      const response: FramesResponse = {
        frames: out,
        nextSeq: out.length > 0 ? out[out.length - 1].seq : Math.max(from, lastSeq),
        done: terminal
      };
      // The cursor points into frames we no longer hold: report the gap so the
      // host can record "events were lost" instead of pretending continuity.
      if (from + 1 < firstSeq && frames.length > 0) {
        response.droppedBefore = firstSeq;
      }
      return response;
    },
    isTerminal() {
      return terminal;
    },
    expiredReason() {
      const t = now();
      if (t - startedAtMs > maxLifetimeMs) return "max-lifetime";
      if (terminal && finishedAtMs != null && t - finishedAtMs > terminalHoldMs) return "terminal-hold";
      if (t - lastContactAtMs > noContactTtlMs) return "no-contact";
      return null;
    }
  };
}

function defaultTokenFactory(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    // Randomness is only needed to make a token unguessable by a superseded
    // reader; the Bearer secret is the actual auth boundary.
    const rand = Math.floor(Number.MAX_SAFE_INTEGER * pseudoRandom()).toString(36);
    return `at_${counter}_${rand}`;
  };
}

// Indirection so the module stays free of a direct Math.random reference at
// call sites that tests replace with a deterministic factory.
function pseudoRandom(): number {
  return Math.random();
}
