import { spawn, type ChildProcess } from "node:child_process";

// Remembers which agent containers the kernel OOM-killed, from `docker events`.
//
// A container killed at its --memory limit looks like any other dropped
// session to the runner ("fetch failed: ECONNREFUSED", "exited without a
// result"), which isRetryableAgentError treats as transient — so an OOM-killed
// run was relaunched up to three more times, each time filling the same
// memory again and holding a slot in the memory queue (2026-10-20..22: ~40 OOM
// kills, most of them retries). With this, the runner can tell an OOM apart
// and fail the run once with an actionable message instead.
//
// Lives on globalThis like the run registry: instrumentation.ts and route
// handlers run in different module contexts.

type OomWatchState = {
  child: ChildProcess | null;
  killedAt: Map<string, number>;
  restartTimer: NodeJS.Timeout | null;
};

const GLOBAL_KEY = Symbol.for("rdocs.agentOomWatch");
const KEEP_MS = 60 * 60 * 1000;

function state(): OomWatchState {
  const g = globalThis as unknown as Record<symbol, OomWatchState | undefined>;
  g[GLOBAL_KEY] ??= { child: null, killedAt: new Map(), restartTimer: null };
  return g[GLOBAL_KEY]!;
}

/** Record an OOM kill (exported for tests and for the event parser). */
export function recordOomKill(containerName: string, at = Date.now()) {
  const { killedAt } = state();
  killedAt.set(containerName, at);
  for (const [name, time] of killedAt) {
    if (at - time > KEEP_MS) killedAt.delete(name);
  }
}

/** Forget a container name before (re)launching it — names are reused by retries. */
export function clearOomKill(containerName: string) {
  state().killedAt.delete(containerName);
}

/**
 * True when `containerName` was OOM-killed. The docker event can trail the
 * runner's own failure by a moment, so this waits up to `waitMs` for it.
 */
export async function wasOomKilled(containerName: string, waitMs = 3000): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (state().killedAt.has(containerName)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Start the `docker events` listener once per process. Restarts if it exits. */
export function startOomWatch(runtime = process.env.AGENT_CONTAINER_RUNTIME || "docker") {
  const s = state();
  if (s.child || s.restartTimer) return;
  const child = spawn(runtime, ["events", "--filter", "event=oom", "--format", "{{.Actor.Attributes.name}}"], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  s.child = child;
  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const name = line.trim();
      if (!name.startsWith("gdocs-")) continue;
      console.warn(`[agent-runner] container ${name} was OOM-killed at its memory limit`);
      recordOomKill(name);
    }
  });
  const restart = () => {
    if (s.child !== child) return;
    s.child = null;
    s.restartTimer = setTimeout(() => {
      s.restartTimer = null;
      startOomWatch(runtime);
    }, 5000);
    s.restartTimer.unref?.();
  };
  child.on("error", restart);
  child.on("close", restart);
  child.unref();
}

export class AgentOutOfMemoryError extends Error {
  constructor(memoryLimit: string) {
    super(
      `The agent's sandbox ran out of memory (limit ${memoryLimit}) and was stopped. ` +
        "Processes inside it used more RAM than that — e.g. loading a model or a large dataset, " +
        "many parallel workers, or big docker images pulled inside the sandbox. " +
        "/tmp and the home directory are on disk and do not count. " +
        "Retrying the same work will hit the same limit; split it up, stream the data, or run it elsewhere (e.g. on a GPU job)."
    );
    this.name = "AgentOutOfMemoryError";
  }
}
