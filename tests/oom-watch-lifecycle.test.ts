import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// The OOM watcher is a long-lived `docker events` child. It used to outlive
// the process that started it: `docker events` only notices its closed stdout
// when it next writes, and OOM events are rare, so every server that was
// replaced by a deploy and every finished `scripts/run-agent-job.ts` left one
// behind (2026-11-10: eleven on the host, the oldest three weeks old, two of
// them pinning the systemd scopes of long-gone app colors). Its stdout pipe
// also kept the starting script's event loop alive, so run-agent-job never
// exited by itself.
//
// A fake runtime that records its pid and then sleeps stands in for docker.

const TSX = path.join(process.cwd(), "node_modules", ".bin", "tsx");
const OOM_WATCH = path.join(process.cwd(), "lib", "agent-runner", "oom-watch.ts");

function setup(parentBody: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "oom-watch-"));
  const pidFile = path.join(dir, "runtime.pid");
  const runtime = path.join(dir, "fake-docker");
  writeFileSync(runtime, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 600\n`);
  chmodSync(runtime, 0o755);
  const entry = path.join(dir, "parent.ts");
  writeFileSync(
    entry,
    `import { startOomWatch } from ${JSON.stringify(OOM_WATCH)};\nstartOomWatch(${JSON.stringify(runtime)});\n${parentBody}\n`
  );
  return { pidFile, entry };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(condition: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return condition();
}

async function runtimePid(pidFile: string) {
  assert.ok(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 15000), "fake runtime started");
  return Number(readFileSync(pidFile, "utf8").trim());
}

test("oom watcher: the docker events child dies with a parent that is SIGKILLed", async () => {
  const { pidFile, entry } = setup("setInterval(() => {}, 1000);");
  const parent = spawn(TSX, [entry], { stdio: "ignore" });
  const pid = await runtimePid(pidFile);
  try {
    assert.ok(alive(pid));
    // tsx runs the script in a child node process; kill the whole family the
    // hard way, as a crashed or `kill -9`ed server would go.
    spawn("pkill", ["-9", "-P", String(parent.pid)]).on("close", () => parent.kill("SIGKILL"));
    assert.ok(await waitFor(() => !alive(pid), 8000), "watcher child must not outlive its parent");
  } finally {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
});

test("oom watcher: it does not keep a finished script alive, and is gone afterwards", async () => {
  const { pidFile, entry } = setup("");
  const parent = spawn(TSX, [entry], { stdio: "ignore" });
  const exited = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 15000);
    parent.on("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  const pid = await runtimePid(pidFile).catch(() => 0);
  try {
    assert.ok(await exited, "a script that only started the watcher must exit by itself");
    if (pid) assert.ok(await waitFor(() => !alive(pid), 8000), "watcher child must be gone after the script exits");
  } finally {
    parent.kill("SIGKILL");
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  }
});
