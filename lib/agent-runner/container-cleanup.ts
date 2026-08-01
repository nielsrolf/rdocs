import { spawn } from "node:child_process";

import { db } from "@/lib/db";

// Container names created by the three agent routes (ai-edit, conversation,
// ask-ai) — keep in sync with their `containerName: \`gdocs-run-${aiRunId}\``.
export const RUN_CONTAINER_PREFIX = "gdocs-run-";

export function containerNameForRun(aiRunId: string) {
  return `${RUN_CONTAINER_PREFIX}${aiRunId}`;
}

type ExecResult = { code: number | null; stdout: string };
type Exec = (cmd: string, args: string[]) => Promise<ExecResult>;

export type ContainerCleanupOptions = { runtime?: string; exec?: Exec };

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    // A missing runtime binary (docker not installed → in-process runner
    // deployments) must never throw out of a reaper sweep.
    child.on("error", () => resolve({ code: -1, stdout: "" }));
    child.on("close", (code) => resolve({ code, stdout }));
  });

function resolveOpts(opts: ContainerCleanupOptions) {
  return {
    runtime: opts.runtime ?? process.env.AGENT_CONTAINER_RUNTIME ?? "docker",
    exec: opts.exec ?? defaultExec
  };
}

// Force-remove the containers of the given runs. Best-effort by design:
// `rm -f` on a name that doesn't exist (in-process run, or the container's
// `--rm` already cleaned it up) exits non-zero and that is fine — the names
// that DO exist are still removed in the same invocation.
export async function removeRunContainers(runIds: string[], opts: ContainerCleanupOptions = {}): Promise<void> {
  if (runIds.length === 0) return;
  const { runtime, exec } = resolveOpts(opts);
  await exec(runtime, ["rm", "-f", ...runIds.map(containerNameForRun)]);
}

// List the aiRunIds of all currently existing agent containers, or null when
// the container runtime is unavailable (treat as "nothing to reconcile").
export async function listRunContainerIds(opts: ContainerCleanupOptions = {}): Promise<string[] | null> {
  const { runtime, exec } = resolveOpts(opts);
  const { code, stdout } = await exec(runtime, [
    "ps",
    "--all",
    "--format",
    "{{.Names}}",
    "--filter",
    `name=${RUN_CONTAINER_PREFIX}`
  ]);
  if (code !== 0) return null;
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name.startsWith(RUN_CONTAINER_PREFIX))
    .map((name) => name.slice(RUN_CONTAINER_PREFIX.length));
}

// Boot/periodic reconciliation: remove every agent container whose AiRun is
// terminal (SUCCEEDED/FAILED/CANCELLED — e.g. reaped as abandoned before this
// mechanism existed) or unknown. Containers of RUNNING/PENDING runs are
// deliberately spared: with blue/green deploys they may belong to the draining
// sibling process, whose heartbeats keep the silence reaper away. When such a
// run's owner really is dead, the reaper fails it and kills the container via
// the failAbandonedAiRuns hook — this sweep then never sees it again.
export async function reconcileRunContainers(opts: ContainerCleanupOptions = {}): Promise<{ removed: string[] }> {
  const ids = await listRunContainerIds(opts);
  if (!ids || ids.length === 0) {
    return { removed: [] };
  }
  const liveRuns = await db.aiRun.findMany({
    where: { id: { in: ids }, status: { in: ["RUNNING", "PENDING"] } },
    select: { id: true }
  });
  const live = new Set(liveRuns.map((run) => run.id));
  const orphans = ids.filter((id) => !live.has(id));
  if (orphans.length > 0) {
    console.warn(
      `[reaper] removing ${orphans.length} orphaned agent container(s): ${orphans
        .map(containerNameForRun)
        .join(", ")}`
    );
    await removeRunContainers(orphans, opts);
  }
  return { removed: orphans };
}
