import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

// Per-run scratch space on DISK for the agent container's /tmp and HOME.
//
// Both used to be tmpfs, i.e. RAM charged to the container's --memory limit:
// a venv built in /tmp/venv or a repo cloned into /tmp/up pushed research runs
// over 6 GiB and got them OOM-killed (2026-10-20..22). Verified under gVisor:
// 2 GiB written to a bind-mounted host dir fits in a 1 GiB container, 2 GiB in
// a tmpfs /tmp gets it killed. Note the HOST /tmp is tmpfs too, hence a
// directory under the app (or AGENT_SCRATCH_ROOT), not os.tmpdir().
//
// Files created by (sandboxed) root come back root-owned on the host, so
// removal falls back to a throwaway root container.

type Env = Record<string, string | undefined>;

export function agentScratchRoot(env: Env = process.env) {
  return env.AGENT_SCRATCH_ROOT || path.join(process.cwd(), ".agent-scratch");
}

export function agentScratchEnabled(env: Env = process.env) {
  return env.AGENT_SCRATCH_ON_DISK !== "0";
}

/** Create `<root>/<name>/{tmp,home}` and return `<root>/<name>`. */
export async function prepareRunScratch(name: string, env: Env = process.env): Promise<string> {
  const dir = path.join(agentScratchRoot(env), name.replace(/[^a-zA-Z0-9_.-]+/g, "-"));
  await mkdir(path.join(dir, "tmp"), { recursive: true });
  await mkdir(path.join(dir, "home"), { recursive: true });
  // /tmp semantics (sticky, world-writable): the agent drops to the host uid
  // after the sandbox's root started dockerd.
  await chmod(path.join(dir, "tmp"), 0o1777);
  return dir;
}

function run(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code));
  });
}

/** Remove a run's scratch dir, including files the sandbox's root created. Best-effort. */
export async function removeRunScratch(dir: string, opts: { runtime: string; image: string }) {
  try {
    await rm(dir, { recursive: true, force: true });
    return;
  } catch {
    // root-owned files: fall through to a root container
  }
  const code = await run(opts.runtime, [
    "run", "--rm", "--network", "none", "--user", "0:0",
    "-v", `${dir}:/scratch`, "--entrypoint", "rm", opts.image, "-rf", "/scratch/tmp", "/scratch/home"
  ]);
  await rm(dir, { recursive: true, force: true }).catch((error) => {
    console.warn(`[agent-runner] could not remove scratch ${dir} (root rm exit ${code}): ${String(error)}`);
  });
}

/**
 * Remove scratch dirs left behind by a process that died mid-run (crash, kill,
 * host restart). Spares any dir whose container still exists and anything
 * touched in the last `minAgeMs`.
 */
export async function sweepOrphanedScratch(opts: {
  runtime: string;
  image: string;
  existingContainerNames: Set<string>;
  minAgeMs?: number;
  env?: Env;
}) {
  const root = agentScratchRoot(opts.env);
  const entries = await readdir(root).catch(() => [] as string[]);
  const cutoff = Date.now() - (opts.minAgeMs ?? 60 * 60 * 1000);
  let removed = 0;
  for (const name of entries) {
    if (opts.existingContainerNames.has(name)) continue;
    const dir = path.join(root, name);
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory() || info.mtimeMs > cutoff) continue;
    await removeRunScratch(dir, opts);
    removed += 1;
  }
  if (removed > 0) console.log(`[agent-runner] swept ${removed} orphaned scratch dir(s)`);
  return removed;
}
