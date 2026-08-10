// Host-side client for a detached agent session container.
//
// The app is a STATELESS reader here: everything it needs to resume — the job,
// the frame log, the outcome — lives in the container, and the only thing the
// app must remember is a cursor (`AiRun.frameCursor`). That is what makes a run
// survive the process that started it: a newer deployment attaches to the same
// container, replays from the persisted cursor, and keeps going.
//
// Failure semantics that matter:
//   * 409 attach-superseded → another process took over. Stop. Do NOT retry;
//     competing readers would double-persist frames.
//   * network errors are transient by default (a deploy restarts nothing on the
//     container side), so the poll loop retries with a small backoff until the
//     signal aborts or the container is really gone.

import {
  ATTACH_TOKEN_HEADER,
  type AgentSessionFrame,
  type AgentSessionStatus,
  type AttachResponse,
  type FramesResponse
} from "@/agent-core/session-protocol";

export class AttachSupersededError extends Error {
  constructor() {
    super("Another process attached to this agent session container.");
    this.name = "AttachSupersededError";
  }
}

export class SessionGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionGoneError";
  }
}

export type AgentSessionClient = {
  baseUrl: string;
  /** `probeOnly` reads liveness without counting as contact (see /status). */
  status(probeOnly?: boolean): Promise<AgentSessionStatus>;
  /** Take over the session; invalidates any other process's attach token. */
  attach(): Promise<AttachResponse>;
  /** False when a job was already accepted (i.e. this is a resume). */
  postJob(job: unknown): Promise<boolean>;
  /**
   * Long-poll for frames after `since`. Passing the run's abort signal is what
   * makes a cancel take effect immediately instead of at the end of the current
   * poll window.
   */
  frames(since: number, waitMs?: number, signal?: AbortSignal): Promise<FramesResponse>;
  message(text: string): Promise<boolean>;
  cancel(): Promise<void>;
  /** Tell the container its result has been persisted and it may exit. */
  release(): Promise<void>;
};

export function createAgentSessionClient(options: {
  baseUrl: string;
  secret: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): AgentSessionClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  let token = options.token ?? null;

  const call = async (
    method: string,
    path: string,
    init?: { body?: unknown; timeoutMs?: number; requireToken?: boolean; signal?: AbortSignal }
  ): Promise<unknown> => {
    const headers: Record<string, string> = { authorization: `Bearer ${options.secret}` };
    if (init?.body !== undefined) headers["content-type"] = "application/json";
    if (token && init?.requireToken !== false) headers[ATTACH_TOKEN_HEADER] = token;
    const controller = new AbortController();
    const timer = init?.timeoutMs ? setTimeout(() => controller.abort(), init.timeoutMs) : null;
    // A caller signal (the run's cancellation) must cut a long-poll short, not
    // wait out its window.
    const onOuterAbort = () => controller.abort();
    if (init?.signal) {
      if (init.signal.aborted) controller.abort();
      else init.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl}${path}`, {
        method,
        headers,
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal
      });
    } finally {
      if (timer) clearTimeout(timer);
      init?.signal?.removeEventListener("abort", onOuterAbort);
    }
    if (response.status === 409) {
      throw new AttachSupersededError();
    }
    if (!response.ok) {
      throw new SessionGoneError(`agent session ${method} ${path} failed with HTTP ${response.status}`);
    }
    return await response.json();
  };

  return {
    baseUrl: options.baseUrl,
    async status(probeOnly = false) {
      const path = probeOnly ? "/status?probe=1" : "/status";
      return (await call("GET", path, { timeoutMs: 10_000, requireToken: false })) as AgentSessionStatus;
    },
    async attach() {
      const attached = (await call("POST", "/attach", { timeoutMs: 10_000, requireToken: false })) as AttachResponse;
      token = attached.token;
      return attached;
    },
    async postJob(job) {
      const result = (await call("POST", "/job", { body: { job }, timeoutMs: 30_000 })) as { accepted?: boolean };
      return result.accepted === true;
    },
    async frames(since, waitMs = 25_000, signal) {
      return (await call("GET", `/frames?since=${since}&wait=${waitMs}`, {
        timeoutMs: waitMs + 15_000,
        signal
      })) as FramesResponse;
    },
    async message(text) {
      const result = (await call("POST", "/message", { body: { text }, timeoutMs: 10_000 })) as {
        delivered?: boolean;
      };
      return result.delivered === true;
    },
    async cancel() {
      await call("POST", "/cancel", { timeoutMs: 10_000 });
    },
    async release() {
      await call("POST", "/release", { timeoutMs: 10_000 }).catch(() => null);
    }
  };
}

/**
 * Liveness check for a persisted session handle: does the container still
 * answer? Used by the reaper, which would otherwise judge a detached run by the
 * silence of a process that is no longer its parent (lib/ai-runs.ts).
 *
 * Deliberately does NOT attach — probing must never supersede whichever process
 * is currently driving the run — and uses the `probe=1` form, which does NOT
 * count as contact: an orphan nobody adopts must still hit its no-contact TTL
 * and exit, or this check would keep it alive forever.
 */
export async function probeAgentSession(
  endpoint: string,
  secret: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  try {
    const client = createAgentSessionClient({ baseUrl: endpoint, secret, fetchImpl });
    await client.status(true);
    return true;
  } catch {
    return false;
  }
}

export type SessionConsumeOutcome =
  | { kind: "result"; output: Record<string, unknown>; cursor: number }
  | { kind: "error"; message: string; cursor: number }
  | { kind: "aborted"; cursor: number };

/**
 * Drive a session to its terminal frame, handing every frame to `onFrame` and
 * reporting the cursor after each batch so the caller can persist it. Returns
 * (rather than throws) on a terminal error frame: "the agent failed" is an
 * outcome, not a transport failure.
 */
export async function consumeAgentSession(options: {
  client: AgentSessionClient;
  since: number;
  onFrame: (frame: AgentSessionFrame) => void | Promise<void>;
  /** Called after a batch is fully handled, with the new cursor. */
  onCursor?: (cursor: number) => void | Promise<void>;
  onGap?: (droppedBefore: number) => void | Promise<void>;
  signal?: AbortSignal;
  waitMs?: number;
  /** Consecutive transport failures tolerated before giving up. */
  maxTransportFailures?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<SessionConsumeOutcome> {
  const { client, onFrame } = options;
  const waitMs = options.waitMs ?? 25_000;
  const maxFailures = options.maxTransportFailures ?? 20;
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let cursor = options.since;
  let failures = 0;

  for (;;) {
    if (options.signal?.aborted) return { kind: "aborted", cursor };
    let batch: FramesResponse;
    try {
      batch = await client.frames(cursor, waitMs, options.signal);
      failures = 0;
    } catch (error) {
      if (error instanceof AttachSupersededError) throw error;
      if (options.signal?.aborted) return { kind: "aborted", cursor };
      failures += 1;
      if (failures >= maxFailures) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      await sleep(Math.min(15_000, 500 * 2 ** Math.min(failures, 5)));
      continue;
    }

    if (batch.droppedBefore != null && options.onGap) {
      await options.onGap(batch.droppedBefore);
    }

    for (const frame of batch.frames) {
      await onFrame(frame);
      cursor = frame.seq;
      if (frame.type === "result") {
        await options.onCursor?.(cursor);
        return { kind: "result", output: (frame.output as Record<string, unknown>) ?? {}, cursor };
      }
      if (frame.type === "error") {
        await options.onCursor?.(cursor);
        return {
          kind: "error",
          message: typeof frame.message === "string" ? frame.message : "Agent container reported an error.",
          cursor
        };
      }
    }
    cursor = Math.max(cursor, batch.nextSeq);
    await options.onCursor?.(cursor);

    // `done` without a terminal frame in this batch means the terminal frame
    // was already consumed by an earlier attach — the caller has the outcome.
    if (batch.done && batch.frames.length === 0) {
      return { kind: "error", message: "Agent session ended without a collectable result.", cursor };
    }
  }
}
