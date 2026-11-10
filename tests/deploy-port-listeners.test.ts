import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

// deploy.sh finds the process holding a color port with `ss -p`, which can
// only name a pid whose /proc/<pid>/fd it may read: same uid AND same primary
// gid. A deploy re-executed under `sg docker` (primary gid docker) therefore
// saw NO listener on the old color started with gid niels: it skipped the
// drain, and every later deploy died with EADDRINUSE on the port the undrained
// process still held (2026-11-10). A fake `ss` that reports the listener
// without a pid reproduces that blindness.

const run = promisify(execFile);
const HELPERS = path.join(process.cwd(), "deploy", "port-listeners.sh");

function fakeSsDir(listenerLine: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-ss-"));
  const file = path.join(dir, "ss");
  writeFileSync(file, `#!/bin/sh\nprintf '%s' '${listenerLine}'\n`);
  chmodSync(file, 0o755);
  return dir;
}

async function sh(script: string, binDir: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await run("bash", ["-c", `set -euo pipefail; . "${HELPERS}"; ${script}`], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` }
    });
    return { stdout: stdout.trim(), code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; code?: number };
    return { stdout: (failure.stdout ?? "").trim(), code: failure.code ?? 1 };
  }
}

test("a listener ss cannot name is still found through the app's health pid", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true, draining: false, pid: 424242, port: "x" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  // What ss prints for a listener owned by another primary gid: no users:(…).
  const bin = fakeSsDir(`LISTEN 0 511 *:${port} *:*\n`);
  try {
    assert.equal((await sh(`port_listeners ${port}`, bin)).stdout, "", "ss alone names no pid");
    assert.equal((await sh(`port_in_use ${port}`, bin)).code, 0, "the port counts as occupied");
    assert.equal((await sh(`app_port_listeners ${port}`, bin)).stdout, "424242");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a pid ss can name wins, and a free port yields nothing", async () => {
  const named = fakeSsDir('LISTEN 0 511 *:1 *:* users:(("next-server (v1",pid=777,fd=21))\n');
  assert.equal((await sh("app_port_listeners 1", named)).stdout, "777");

  const free = fakeSsDir("");
  assert.equal((await sh("app_port_listeners 1", free)).stdout, "");
  assert.notEqual((await sh("port_in_use 1", free)).code, 0);
});
