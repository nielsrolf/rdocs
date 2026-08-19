// Global cap on concurrently running sandboxed agent containers.
//
// Motivation: on 2026-07-28 an unbounded burst of Slack/scheduled runs put 31
// agent containers (4g memory limit each) on an 8 GiB docker VM, OOM-thrashing
// the VM and taking litellm down with it. Runs beyond the cap now queue (FIFO)
// instead of spawning; a queued run's heartbeat keeps it alive and its abort
// signal still cancels it while waiting.
//
// The cap is per next-server process. During a blue/green deploy overlap two
// processes exist briefly, so the effective ceiling can reach 2x the cap —
// size AGENT_MAX_CONCURRENT_RUNS with that in mind.

const DEFAULT_MAX_CONCURRENT_RUNS = 4;

type Waiter = {
  grant: () => void;
  abort: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export class RunSlotSemaphore {
  private active = 0;
  private waiters: Waiter[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`[agent-concurrency] limit must be a positive integer, got ${limit}`);
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  // Resolves with an idempotent release function once a slot is free. If the
  // signal aborts while queued, rejects with signal.reason and gives up the
  // queue position.
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("aborted while waiting for an agent run slot"));
    }
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => resolve(this.makeRelease()),
        abort: (reason) => reject(reason ?? new Error("aborted while waiting for an agent run slot")),
        signal
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          waiter.abort(signal.reason);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Hand the slot straight to the next waiter; `active` stays constant.
        if (next.signal && next.onAbort) {
          next.signal.removeEventListener("abort", next.onAbort);
        }
        next.grant();
      } else {
        this.active -= 1;
      }
    };
  }
}

export function resolveAgentRunLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  return DEFAULT_MAX_CONCURRENT_RUNS;
}

let singleton: RunSlotSemaphore | null = null;

export function agentRunSemaphore(): RunSlotSemaphore {
  if (!singleton) {
    singleton = new RunSlotSemaphore(resolveAgentRunLimit(process.env.AGENT_MAX_CONCURRENT_RUNS));
  }
  return singleton;
}
