// Graceful drain for blue/green deploys (deploy/deploy.sh).
//
// After the load balancer switches traffic to the new process, the deploy
// script POSTs /api/admin/drain directly to the OLD process's port. Draining
// means: stop sources of NEW work (Slack socket, scheduler claims), keep
// serving whatever still arrives (stragglers over kept-alive connections),
// let in-flight agent runs finish where they started (they write to the
// shared DB and post to Slack over the Web API — none of that needs this
// process to own the listener), then exit.
//
// The run-registry is the drain criterion: every background agent run
// registers an AbortController for its full lifetime, so an empty registry
// means nothing in-flight would die with the process.

import { activeRunCount } from "@/lib/agent-runner/run-registry";

// Poll cadence while waiting for in-flight runs.
export const DRAIN_POLL_MS = 5_000;
// Hard cap: a run that outlives this is abandoned to the silence reaper
// rather than pinning the old process forever.
export const DRAIN_MAX_MS = 2 * 60 * 60 * 1000;
// After the registry empties, linger briefly so final HTTP responses,
// DB writes and Slack posts flush before the process dies.
export const DRAIN_GRACE_MS = 10_000;

type DrainState = {
  draining: boolean;
  since: Date | null;
};

const state: DrainState = { draining: false, since: null };

export function isDraining(): boolean {
  return state.draining;
}

export function drainingSince(): Date | null {
  return state.since;
}

type DrainDeps = {
  stopIntake?: () => Promise<void>;
  countActiveRuns?: () => number;
  exit?: (code: number) => void;
  pollMs?: number;
  maxMs?: number;
  graceMs?: number;
};

// Idempotent. Returns immediately; the wait-and-exit loop runs in the
// background. deps are injectable for tests — production fills them in.
export function beginDrain(deps: DrainDeps = {}): { alreadyDraining: boolean } {
  if (state.draining) {
    return { alreadyDraining: true };
  }
  state.draining = true;
  state.since = new Date();

  const countActiveRuns = deps.countActiveRuns ?? activeRunCount;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const pollMs = deps.pollMs ?? DRAIN_POLL_MS;
  const maxMs = deps.maxMs ?? DRAIN_MAX_MS;
  const graceMs = deps.graceMs ?? DRAIN_GRACE_MS;

  const stopIntake =
    deps.stopIntake ??
    (async () => {
      const [{ stopSlackSocketService }, { stopSchedulerLoop }] = await Promise.all([
        import("@/lib/slack/service"),
        import("@/lib/scheduler")
      ]);
      await stopSlackSocketService();
      stopSchedulerLoop();
    });

  console.log("[drain] begin", { pid: process.pid, activeRuns: countActiveRuns() });

  void (async () => {
    try {
      await stopIntake();
    } catch (error) {
      console.error("[drain] stopping intake failed (continuing)", {
        error: error instanceof Error ? error.message : error
      });
    }

    const deadline = Date.now() + maxMs;
    let lastLogged = -1;
    while (countActiveRuns() > 0 && Date.now() < deadline) {
      const active = countActiveRuns();
      if (active !== lastLogged) {
        console.log("[drain] waiting for in-flight runs", { activeRuns: active });
        lastLogged = active;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    const leftover = countActiveRuns();
    if (leftover > 0) {
      console.warn("[drain] max drain time reached; exiting with runs still active", {
        activeRuns: leftover
      });
    } else {
      console.log("[drain] no active runs; exiting after grace period", { graceMs });
    }
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    console.log("[drain] exit", { pid: process.pid });
    exit(0);
  })();

  return { alreadyDraining: false };
}

// Test-only: reset module state so multiple tests can exercise beginDrain.
export function resetDrainStateForTests() {
  state.draining = false;
  state.since = null;
}
