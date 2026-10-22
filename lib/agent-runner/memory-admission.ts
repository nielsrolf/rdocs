import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";

// Memory-aware admission for agent containers.
//
// Motivation: on 2026-10-14..16 the 30 GiB host repeatedly swapped itself
// unresponsive (ssh, caddy and journald all stalled for up to two hours). Five
// concurrent runs x a 16g --memory limit allowed 80 GiB on a 30 GiB box; a
// gVisor sandbox pulling images into its tmpfs-backed inner docker store
// reached 12-14 GiB, two of those at once exhausted the host, and the global
// OOM killer only fired after the box had thrashed for minutes.
//
// A run is admitted only when the --memory limits of all running gdocs-*
// containers (read from docker, so blue/green overlap, detached sessions that
// survived a restart and durable containers all count) plus its own fit into
// AGENT_MEMORY_BUDGET, and the host still has AGENT_MIN_AVAILABLE_MEMORY free.
// Otherwise it waits (FIFO). Because the sum of limits never exceeds the
// budget, the only thing that can still be OOM-killed is a run that exceeds
// its OWN limit — inside its own cgroup, not the whole host.

export type RunContainer = { name: string; limitBytes: number };

export type MemoryProbe = {
  /** Running gdocs-* containers with their --memory limit (0 = unlimited), or null if the runtime is unavailable. */
  containers(): Promise<RunContainer[] | null>;
  /** Host MemAvailable in bytes, or null when unknown. */
  availableBytes(): Promise<number | null>;
};

export type AdmissionSnapshot = {
  reservedBytes: number;
  budgetBytes: number;
  availableBytes: number | null;
  minAvailableBytes: number;
};

type Grant = { name?: string; bytes: number };

type Waiter = {
  grant: Grant;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  onQueued?: (reason: string) => void;
  notified: boolean;
};

const UNITS: Record<string, number> = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

/** Parse a docker-style size ("6g", "512m", "1.5G", "1073741824"). Returns null when unparsable. */
export function parseMemorySize(raw: string | undefined | null): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([bkmgt]?)i?b?\s*$/i.exec(raw ?? "");
  if (!match) return null;
  const bytes = Math.round(Number(match[1]) * UNITS[match[2].toLowerCase()]);
  return bytes > 0 ? bytes : null;
}

export function formatGiB(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export class MemoryAdmission {
  private readonly grants = new Set<Grant>();
  private waiters: Waiter[] = [];
  private pumping = false;
  private repump = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly opts: {
      budgetBytes: number;
      minAvailableBytes: number;
      /** Charged for a running container that has no --memory limit. */
      unlimitedContainerBytes: number;
      /**
       * Charged for a running gdocs-run-* container (e.g. a blue/green
       * sibling's run) instead of its --memory limit — the same reservation
       * our own grants use. Unset → its limit.
       */
      runContainerBytes?: number;
      probe: MemoryProbe;
      pollMs?: number;
    }
  ) {}

  get queuedCount() {
    return this.waiters.length;
  }

  get budgetBytes() {
    return this.opts.budgetBytes;
  }

  async snapshot(): Promise<AdmissionSnapshot> {
    const [containers, availableBytes] = await Promise.all([
      this.opts.probe.containers().catch(() => null),
      this.opts.probe.availableBytes().catch(() => null)
    ]);
    // Our own grants are charged at their requested size; their containers
    // (once started) are skipped so they are not counted twice. Containers we
    // did not grant — another process, an adopted detached session, a durable
    // app — are charged at their docker limit.
    const ownNames = new Set([...this.grants].map((g) => g.name).filter(Boolean));
    let reservedBytes = 0;
    for (const grant of this.grants) reservedBytes += grant.bytes;
    for (const container of containers ?? []) {
      if (ownNames.has(container.name)) continue;
      if (this.opts.runContainerBytes !== undefined && container.name.startsWith("gdocs-run-")) {
        reservedBytes += this.opts.runContainerBytes;
        continue;
      }
      reservedBytes += container.limitBytes > 0 ? container.limitBytes : this.opts.unlimitedContainerBytes;
    }
    return {
      reservedBytes,
      budgetBytes: this.opts.budgetBytes,
      availableBytes,
      minAvailableBytes: this.opts.minAvailableBytes
    };
  }

  /** Why `bytes` cannot start now, or null when it fits. */
  blockedReason(snap: AdmissionSnapshot, bytes: number): string | null {
    // A request larger than the whole budget still runs — alone — instead of
    // queueing forever.
    if (snap.reservedBytes > 0 && snap.reservedBytes + bytes > snap.budgetBytes) {
      return `${formatGiB(snap.reservedBytes)} of the ${formatGiB(snap.budgetBytes)} agent memory budget is in use`;
    }
    if (snap.availableBytes !== null && snap.availableBytes < snap.minAvailableBytes) {
      return `only ${formatGiB(snap.availableBytes)} of host memory is free`;
    }
    return null;
  }

  /**
   * Resolves with an idempotent release once the run fits. `onQueued` is
   * called once, with the reason, if the run has to wait.
   */
  admit(
    request: { name?: string; bytes: number },
    opts: { signal?: AbortSignal; onQueued?: (reason: string) => void } = {}
  ): Promise<() => void> {
    const { signal } = opts;
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("aborted while waiting for agent memory"));
    }
    const grant: Grant = { name: request.name, bytes: request.bytes };
    // Every request goes through the single-flight pump, even when the queue
    // is empty: checking outside it let parallel admits all see the same free
    // budget and all start.
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { grant, resolve, reject, signal, onQueued: opts.onQueued, notified: false };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason ?? new Error("aborted while waiting for agent memory"));
          this.schedulePump(0);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.schedulePump(0);
    });
  }

  private take(grant: Grant): () => void {
    this.grants.add(grant);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.grants.delete(grant);
      this.schedulePump(0);
    };
  }

  private schedulePump(delayMs: number) {
    if (this.waiters.length === 0) return;
    if (delayMs === 0) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      void this.pump();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, delayMs);
    this.timer.unref?.();
  }

  private notifyQueued(headReason: string) {
    this.waiters.forEach((waiter, index) => {
      if (waiter.notified) return;
      waiter.notified = true;
      waiter.onQueued?.(index === 0 ? headReason : `${index} run(s) ahead are waiting for memory`);
    });
  }

  // Grants waiters strictly in FIFO order: the head blocks everyone behind it,
  // so a large run is not starved by a stream of small ones.
  private async pump() {
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.repump = false;
        while (this.waiters.length > 0) {
          const head = this.waiters[0];
          const reason = this.blockedReason(await this.snapshot(), head.grant.bytes);
          if (this.waiters[0] !== head) continue; // head aborted during the probe
          if (reason !== null) {
            this.notifyQueued(reason);
            break;
          }
          this.waiters.shift();
          if (head.signal && head.onAbort) head.signal.removeEventListener("abort", head.onAbort);
          head.resolve(this.take(head.grant));
        }
      } while (this.repump);
    } finally {
      this.pumping = false;
    }
    // Containers outside our control (other process, durable apps, manual
    // `docker stop`) free memory without telling us — poll while anyone waits.
    this.schedulePump(this.opts.pollMs ?? 5000);
  }
}

type Exec = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve({ code: -1, stdout: "" }));
    child.on("close", (code) => resolve({ code, stdout }));
  });

export function dockerMemoryProbe(runtime: string, exec: Exec = defaultExec): MemoryProbe {
  return {
    async containers() {
      const ps = await exec(runtime, ["ps", "--format", "{{.Names}}", "--filter", "name=^gdocs-"]);
      if (ps.code !== 0) return null;
      const names = ps.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      if (names.length === 0) return [];
      const inspect = await exec(runtime, ["inspect", "--format", "{{.Name}}|{{.HostConfig.Memory}}", ...names]);
      // A container can exit between ps and inspect (non-zero exit), but the
      // lines for the ones that still exist are printed regardless.
      return inspect.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, limit] = line.split("|");
          return { name: name.replace(/^\//, ""), limitBytes: Number(limit) || 0 };
        });
    },
    async availableBytes() {
      if (process.platform !== "linux") return os.freemem();
      const meminfo = await readFile("/proc/meminfo", "utf8");
      const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
      return match ? Number(match[1]) * 1024 : null;
    }
  };
}

/** Per-container --memory limit the runner passes to docker. */
export function agentContainerMemory(env: Record<string, string | undefined> = process.env): string {
  return env.AGENT_CONTAINER_MEMORY || "4g";
}

export function resolveMemoryAdmissionConfig(env: Record<string, string | undefined> = process.env) {
  const perRunBytes = parseMemorySize(agentContainerMemory(env)) ?? 4 * 1024 ** 3;
  return {
    perRunBytes,
    // What a run is charged against the budget. Defaults to its hard limit
    // (no overcommit). Lower it to admit more runs than limits strictly allow:
    // most runs stay far below their limit, and AGENT_MIN_AVAILABLE_MEMORY
    // (plus earlyoom on the host) cover the rare run that actually uses it.
    reservationBytes: Math.min(
      parseMemorySize(env.AGENT_CONTAINER_MEMORY_RESERVATION) ?? perRunBytes,
      perRunBytes
    ),
    // Default: 60% of physical RAM — the rest is for everything else on the box.
    budgetBytes: parseMemorySize(env.AGENT_MEMORY_BUDGET) ?? Math.floor(os.totalmem() * 0.6),
    minAvailableBytes: parseMemorySize(env.AGENT_MIN_AVAILABLE_MEMORY) ?? 3 * 1024 ** 3
  };
}

let singleton: MemoryAdmission | null = null;

export function agentMemoryAdmission(): MemoryAdmission {
  if (!singleton) {
    const config = resolveMemoryAdmissionConfig();
    singleton = new MemoryAdmission({
      budgetBytes: config.budgetBytes,
      minAvailableBytes: config.minAvailableBytes,
      unlimitedContainerBytes: config.perRunBytes,
      runContainerBytes: config.reservationBytes,
      probe: dockerMemoryProbe(process.env.AGENT_CONTAINER_RUNTIME || "docker")
    });
    console.log(
      `[agent-memory] budget ${formatGiB(config.budgetBytes)}, ${formatGiB(config.reservationBytes)} reserved / ` +
        `${formatGiB(config.perRunBytes)} limit per run, ` +
        `min free ${formatGiB(config.minAvailableBytes)}`
    );
  }
  return singleton;
}
