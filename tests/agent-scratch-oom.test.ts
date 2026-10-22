import assert from "node:assert/strict";
import { mkdtemp, readdir, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildContainerRunArgs } from "../lib/agent-runner/container-args";
import { AgentOutOfMemoryError, clearOomKill, recordOomKill, wasOomKilled } from "../lib/agent-runner/oom-watch";
import { prepareRunScratch, removeRunScratch, sweepOrphanedScratch } from "../lib/agent-runner/scratch";

const baseSpec = {
  image: "gdocs-agent:local",
  workspaceHostPath: "/host/ws",
  envFileHostPath: "/host/env",
  memory: "6g"
};

function mountsFor(args: string[], target: string) {
  const out: string[] = [];
  args.forEach((arg, i) => {
    if ((arg === "-v" || arg === "--tmpfs") && args[i + 1]?.includes(target)) out.push(`${arg} ${args[i + 1]}`);
  });
  return out;
}

test("gVisor profile: /tmp and HOME are bind-mounted from disk scratch, not tmpfs", () => {
  const args = buildContainerRunArgs({ ...baseSpec, innerDocker: "gvisor", scratchHostPath: "/data/scratch/gdocs-run-x/" });
  assert.deepEqual(mountsFor(args, ":/tmp"), ["-v /data/scratch/gdocs-run-x/tmp:/tmp:rw"]);
  assert.deepEqual(mountsFor(args, ":/home/agent"), ["-v /data/scratch/gdocs-run-x/home:/home/agent:rw"]);
  assert.ok(!args.some((a) => a.startsWith("/tmp:rw")), "no tmpfs /tmp left");
  // The inner docker store stays tmpfs (gVisor needs it for overlayfs).
  assert.ok(args.some((a) => a.startsWith("/var/lib/docker:")));
});

test("hardened runc profile also uses the disk scratch", () => {
  const args = buildContainerRunArgs({ ...baseSpec, scratchHostPath: "/data/s", uid: 1000, gid: 1000 });
  assert.deepEqual(mountsFor(args, ":/tmp"), ["-v /data/s/tmp:/tmp:rw"]);
});

test("without a scratch path /tmp and HOME stay tmpfs (durable apps, other callers)", () => {
  const args = buildContainerRunArgs({ ...baseSpec, innerDocker: "gvisor" });
  assert.ok(args.includes("/tmp:rw,nosuid,nodev,exec"));
  assert.ok(args.includes("/home/agent:rw,nosuid,nodev,exec"));
});

test("an OOM kill is remembered per container name and cleared before a relaunch", async () => {
  recordOomKill("gdocs-run-oom1");
  assert.equal(await wasOomKilled("gdocs-run-oom1", 0), true);
  assert.equal(await wasOomKilled("gdocs-run-other", 0), false);
  clearOomKill("gdocs-run-oom1");
  assert.equal(await wasOomKilled("gdocs-run-oom1", 0), false);
});

test("wasOomKilled waits for a docker event that trails the runner's own failure", async () => {
  setTimeout(() => recordOomKill("gdocs-run-late"), 100);
  assert.equal(await wasOomKilled("gdocs-run-late", 2000), true);
});

test("the OOM error is not something isRetryableAgentError would retry", async () => {
  const { isRetryableAgentError } = await import("../agent-core");
  assert.equal(isRetryableAgentError(new AgentOutOfMemoryError("6g")), false);
});

test("scratch dirs: prepare, remove, and sweep only orphans older than the cutoff", async () => {
  const root = await mkdtemp(path.join(os.homedir(), ".rdocs-scratch-test-"));
  const env = { AGENT_SCRATCH_ROOT: root };
  const live = await prepareRunScratch("gdocs-run-live", env);
  const orphan = await prepareRunScratch("gdocs-run-orphan", env);
  const fresh = await prepareRunScratch("gdocs-run-fresh", env);
  assert.equal(((await stat(path.join(live, "tmp"))).mode & 0o7777).toString(8), "1777");

  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(live, old, old);
  await utimes(orphan, old, old);
  const removed = await sweepOrphanedScratch({
    runtime: "docker",
    image: "unused",
    existingContainerNames: new Set(["gdocs-run-live"]),
    env
  });
  assert.equal(removed, 1);
  assert.deepEqual((await readdir(root)).sort(), ["gdocs-run-fresh", "gdocs-run-live"]);

  await removeRunScratch(live, { runtime: "docker", image: "unused" });
  await removeRunScratch(fresh, { runtime: "docker", image: "unused" });
  await removeRunScratch(root, { runtime: "docker", image: "unused" });
  void orphan;
});
