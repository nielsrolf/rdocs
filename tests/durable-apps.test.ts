// Durable app mode (lib/durable-apps.ts + lib/agent-runner/durable.ts): pure
// validation helpers, the container args a durable container gets, and the
// runner driving two consecutive jobs through ONE real (in-process) durable
// session server via a fake docker. No Docker, no LLM, no DB.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentSessionState, AGENT_SESSION_SECRET_ENV } from "../agent-core/session-protocol";
import { createAgentSessionServer } from "../agent-core/session-server";
import { durableAppPromptBlock } from "../agent-core/agent";
import {
  durableAppPortRange,
  durableAppsAllowedFor,
  durableContainerName,
  DURABLE_CONTAINER_PREFIX,
  validateAppPort,
  validateDurableHostname
} from "../lib/durable-apps";
import { buildContainerRunArgs } from "../lib/agent-runner/container-args";
import { RUN_CONTAINER_PREFIX } from "../lib/agent-runner/container-cleanup";
import {
  containerSessionConfigDir,
  CONTAINER_SESSIONS_ROOT,
  DURABLE_CONTAINER_RESTARTED_MESSAGE,
  DurableContainerRunner
} from "../lib/agent-runner/durable";
import type { DetachedDockerOps, DetachedSessionHandle } from "../lib/agent-runner/container-session";
import { createAgentSessionClient } from "../lib/agent-runner/session-client";

test("hostnames are one label under the deployment suffix", () => {
  const env = { DURABLE_APP_DOMAIN_SUFFIX: "example.com" };
  assert.equal(validateDurableHostname("Dev", env), "dev.example.com");
  assert.equal(validateDurableHostname("dev.example.com", env), "dev.example.com");
  assert.throws(() => validateDurableHostname("a.b.example.com", env), /label/i);
  assert.throws(() => validateDurableHostname("dev.other.com", env), /example\.com/);
  assert.throws(() => validateDurableHostname("-bad", env));
  assert.throws(() => validateDurableHostname("", env));
});

test("port range and allowlist parse from env", () => {
  assert.deepEqual(durableAppPortRange({}), { from: 16000, to: 16999 });
  assert.deepEqual(durableAppPortRange({ DURABLE_APP_PORT_RANGE: "20000-20010" }), { from: 20000, to: 20010 });
  assert.equal(durableAppsAllowedFor("a@x.com", {}), false, "empty allowlist means nobody");
  assert.equal(durableAppsAllowedFor("A@X.com", { DURABLE_APP_ALLOWED_EMAILS: "b@y.com, a@x.com" }), true);
  assert.equal(durableAppsAllowedFor(null, { DURABLE_APP_ALLOWED_EMAILS: "a@x.com" }), false);
  assert.equal(validateAppPort(3000), 3000);
  assert.throws(() => validateAppPort(0));
  assert.throws(() => validateAppPort(8787), /session/i);
});

test("durable containers never share the per-run name prefix the reaper sweeps", () => {
  assert.ok(!durableContainerName("doc1").startsWith(RUN_CONTAINER_PREFIX));
  assert.ok(durableContainerName("doc1").startsWith(DURABLE_CONTAINER_PREFIX));
});

test("durable container args publish the app port on loopback and flag the session durable", () => {
  const args = buildContainerRunArgs({
    image: "gdocs-agent:local",
    name: "gdocs-durable-doc1",
    agentHarness: "claude-code",
    workspaceHostPath: "/ws/doc1/repo",
    sessionDirHostPath: "/ws/doc1/sessions",
    envFileHostPath: "/tmp/x/env",
    uid: 1000,
    gid: 1000,
    memory: "8g",
    pidsLimit: 2048,
    readOnly: true,
    detached: true,
    durable: true,
    sessionPort: 8787,
    sessionSecret: "s",
    publishPorts: [{ hostPort: 16001, containerPort: 3000 }],
    extraEnv: { GDOCS_APP_PORT: "3000", GDOCS_APP_URL: "https://dev.example.com", "bad key": "x", OK_BUT_SPACED: "a b" }
  });
  const joined = args.join(" ");
  // The container is the workspace's app host: it must come back after a
  // docker/host restart, which rules out --rm (docker rejects the combination).
  assert.ok(args.includes("-d"));
  assert.match(joined, /--restart unless-stopped/);
  assert.ok(!args.includes("--rm"), "a durable container is never auto-removed");
  assert.match(joined, /-p 127\.0\.0\.1:16001:3000/);
  assert.match(joined, /-e AGENT_SESSION_DURABLE=1/);
  assert.match(joined, /-e GDOCS_APP_PORT=3000/);
  assert.match(joined, /-e GDOCS_APP_URL=https:\/\/dev\.example\.com/);
  assert.ok(!joined.includes("bad key"));
  assert.ok(!joined.includes("OK_BUT_SPACED"), "values with whitespace are not shipped on argv");
  assert.equal(args[args.length - 1], "gdocs-agent:local");
});

test("the prompt tells the agent about its durable port and URL", () => {
  assert.equal(durableAppPromptBlock({}), "");
  const block = durableAppPromptBlock({ GDOCS_APP_PORT: "3000", GDOCS_APP_URL: "https://dev.example.com" });
  assert.match(block, /0\.0\.0\.0:3000/);
  assert.match(block, /https:\/\/dev\.example\.com/);
  assert.match(block, /NOT torn down/);
});

test("session config dirs under the mounted root map 1:1; foreign ones get a durable-owned dir", () => {
  const root = "/ws/doc1/sessions";
  assert.deepEqual(containerSessionConfigDir(root, "/ws/doc1/sessions/conv-1", "doc1"), {
    container: `${CONTAINER_SESSIONS_ROOT}/conv-1`,
    host: "/ws/doc1/sessions/conv-1"
  });
  const foreign = containerSessionConfigDir(root, "/ws/doc2/sessions/conv-9", "doc2");
  assert.equal(foreign.container, `${CONTAINER_SESSIONS_ROOT}/shared-doc2`);
  assert.equal(foreign.host, "/ws/doc1/sessions/shared-doc2");
  assert.equal(containerSessionConfigDir(root, undefined, "x/y").container, `${CONTAINER_SESSIONS_ROOT}/shared-x-y`);
});

/**
 * Fake docker: `start` boots a REAL durable session server, secret read from the
 * env file in argv. With `bindDelayMs`, the published port first belongs to a
 * placeholder that resets every connection (what a gVisor container's published
 * port does while the entrypoint is still starting the inner dockerd), and the
 * session server binds it only after the delay.
 */
function fakeDurableDocker(options: { bindDelayMs?: number } = {}) {
  const started: string[][] = [];
  const removed: string[] = [];
  const jobs: Array<Record<string, unknown>> = [];
  let server: ReturnType<typeof createAgentSessionServer> | null = null;
  let emit: (frame: Parameters<ReturnType<typeof createAgentSessionServer>["emit"]>[0]) => void = () => {};
  let bindTimer: NodeJS.Timeout | null = null;
  const cleanup: Array<() => Promise<void>> = [];
  /** Boot the in-process session server the way the entrypoint would. */
  const boot = (secret: string) => {
    const state = createAgentSessionState({ durable: true });
    server = createAgentSessionServer({
      state,
      secret,
      sweepIntervalMs: 0,
      handlers: {
        onJob: (job) => {
          const record = job as Record<string, unknown>;
          jobs.push(record);
          // Answer asynchronously like the entrypoint would.
          setTimeout(() => emit({ type: "result", output: { reply: `done ${jobs.length}` } }), 10);
        },
        onMessage: () => true,
        onCancel: () => {},
        onExit: () => {}
      }
    });
    emit = (frame) => server!.emit(frame);
    return server;
  };
  const ops: DetachedDockerOps = {
    async start(args) {
      started.push(args);
      const envFile = args[args.indexOf("--env-file") + 1];
      const secret = (await readFile(envFile, "utf8"))
        .split("\n")
        .find((line) => line.startsWith(`${AGENT_SESSION_SECRET_ENV}=`))!
        .slice(AGENT_SESSION_SECRET_ENV.length + 1);
      const server = boot(secret);
      if (!options.bindDelayMs) {
        (ops as { port?: number }).port = await server.listen(0, "127.0.0.1");
        return "durable-container-1";
      }
      const placeholder = net.createServer((socket) => socket.destroy());
      const port = await new Promise<number>((resolve) => {
        placeholder.listen(0, "127.0.0.1", () => resolve((placeholder.address() as net.AddressInfo).port));
      });
      (ops as { port?: number }).port = port;
      bindTimer = setTimeout(() => {
        bindTimer = null;
        placeholder.close(() => {
          void server!.listen(port, "127.0.0.1");
        });
      }, options.bindDelayMs);
      cleanup.push(() => new Promise<void>((resolve) => placeholder.close(() => resolve())));
      return "durable-container-1";
    },
    async hostPort() {
      const port = (ops as { port?: number }).port;
      if (!port) throw new Error("agent container spawn failed: no published host port for 8787/tcp");
      return port;
    },
    async remove(id) {
      removed.push(id);
    }
  };
  return {
    ops,
    started,
    removed,
    jobs,
    /** A container the engine restarted on its own: running under a new port, never `start`ed by this process. */
    bootRestarted: async (secret: string) => {
      const port = await boot(secret).listen(0, "127.0.0.1");
      (ops as { port?: number }).port = port;
      return port;
    },
    close: async () => {
      if (bindTimer) clearTimeout(bindTimer);
      for (const fn of cleanup) await fn().catch(() => {});
      await server?.close();
    }
  };
}

test("durable runner: one container, two consecutive jobs, per-job session dir, handle persisted once", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "durable-test-"));
  const sessionsRoot = path.join(tmp, "sessions");
  const docker = fakeDurableDocker();
  const handles: Array<DetachedSessionHandle | null> = [];
  let stored: DetachedSessionHandle | null = null;
  const runner = new DurableContainerRunner(
    {
      workspaceDocumentId: "doc1",
      containerName: "gdocs-durable-doc1",
      hostname: "dev.example.com",
      appPort: 3000,
      hostPort: 16001,
      innerDocker: false,
      sessionsRootHostPath: sessionsRoot
    },
    {
      docker: docker.ops,
      clientFactory: (baseUrl, secret) => createAgentSessionClient({ baseUrl, secret }),
      handleStore: {
        async load() {
          return stored;
        },
        async save(_id, handle) {
          handles.push(handle);
          stored = handle;
        }
      },
      readyTimeoutMs: 5_000,
      busyPollMs: 20
    }
  );
  const previousOci = process.env.AGENT_CONTAINER_OCI_RUNTIME;
  process.env.AGENT_CONTAINER_OCI_RUNTIME = "runc"; // no docker probing in tests
  try {
    const input = { workspacePath: path.join(tmp, "repo") } as never;
    const options = { agentConfig: { model: "claude-sonnet-5" }, agentEnv: { ANTHROPIC_API_KEY: "sk-test" } };
    const first = await runner.run(input, {
      ...options,
      documentId: "doc1",
      sessionDirHostPath: path.join(sessionsRoot, "conv-1")
    } as never);
    assert.deepEqual(first, { reply: "done 1" });
    const second = await runner.run(input, {
      ...options,
      documentId: "doc2",
      sessionDirHostPath: path.join(tmp, "elsewhere", "conv-2")
    } as never);
    assert.deepEqual(second, { reply: "done 2" });

    assert.equal(docker.started.length, 1, "the second run reused the running container");
    assert.equal(docker.jobs.length, 2);
    assert.equal(docker.jobs[0].sessionConfigDir, `${CONTAINER_SESSIONS_ROOT}/conv-1`);
    assert.equal(docker.jobs[1].sessionConfigDir, `${CONTAINER_SESSIONS_ROOT}/shared-doc2`);
    assert.equal((docker.jobs[1].agentEnv as Record<string, string>).GDOCS_DOCUMENT_ID, "doc2");
    // The app port/URL are container env, which the agent-env allowlist strips
    // before the harness (and its Bash tool) sees it — so they must ALSO ride
    // the job env, like the run identity does, or `durableAppPromptBlock` and
    // `dev/run-dev.sh` never learn the port.
    for (const job of docker.jobs) {
      const env = job.agentEnv as Record<string, string>;
      assert.equal(env.GDOCS_APP_PORT, "3000");
      assert.equal(env.GDOCS_APP_URL, "https://dev.example.com");
      assert.equal(env.GDOCS_APP_HOSTNAME, "dev.example.com");
      assert.equal(env.GDOCS_WORKSPACE_DOCUMENT_ID, "doc1");
    }
    const argv = docker.started[0].join(" ");
    assert.match(argv, /-p 127\.0\.0\.1:16001:3000/);
    assert.match(argv, /-e AGENT_SESSION_DURABLE=1/);
    assert.match(argv, /-e GDOCS_APP_URL=https:\/\/dev\.example\.com/);
    assert.match(argv, /--name gdocs-durable-doc1/);
    assert.ok(!argv.includes("--runtime runsc"), "innerDocker=false keeps the hardened profile");
    // save(null) clears stale state before start, then the live handle.
    assert.deepEqual(handles.map((h) => (h ? "handle" : "null")), ["null", "handle"]);
    assert.equal((stored as DetachedSessionHandle | null)?.containerId, "durable-container-1");
  } finally {
    if (previousOci === undefined) delete process.env.AGENT_CONTAINER_OCI_RUNTIME;
    else process.env.AGENT_CONTAINER_OCI_RUNTIME = previousOci;
    await docker.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("durable runner: a fresh container whose session server binds late is waited for, not failed", async () => {
  // Regression: the first durable run on dev.nielsrolf.com failed with
  // "GET .../status?probe=1 transport error: fetch failed: read ECONNRESET" —
  // the busy check probed the just-started container once, before the
  // entrypoint (inner dockerd start + privilege drop) had bound the session port.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "durable-test-"));
  const docker = fakeDurableDocker({ bindDelayMs: 400 });
  let stored: DetachedSessionHandle | null = null;
  const runner = new DurableContainerRunner(
    {
      workspaceDocumentId: "doc1",
      containerName: "gdocs-durable-doc1",
      hostname: null,
      appPort: 3000,
      hostPort: null,
      innerDocker: false,
      sessionsRootHostPath: path.join(tmp, "sessions")
    },
    {
      docker: docker.ops,
      clientFactory: (baseUrl, secret) => createAgentSessionClient({ baseUrl, secret }),
      handleStore: {
        async load() {
          return stored;
        },
        async save(_id, handle) {
          stored = handle;
        }
      },
      readyTimeoutMs: 5_000,
      readyPollMs: 50,
      busyPollMs: 20
    }
  );
  const previousOci = process.env.AGENT_CONTAINER_OCI_RUNTIME;
  process.env.AGENT_CONTAINER_OCI_RUNTIME = "runc";
  try {
    const output = await runner.run({ workspacePath: path.join(tmp, "repo") } as never, {
      agentConfig: { model: "claude-sonnet-5" },
      agentEnv: { ANTHROPIC_API_KEY: "sk-test" },
      documentId: "doc1",
      sessionDirHostPath: path.join(tmp, "sessions", "conv-1")
    } as never);
    assert.deepEqual(output, { reply: "done 1" });
    assert.equal(docker.started.length, 1, "a container that is merely still booting must not be recreated");
    assert.equal(docker.jobs.length, 1);
  } finally {
    if (previousOci === undefined) delete process.env.AGENT_CONTAINER_OCI_RUNTIME;
    else process.env.AGENT_CONTAINER_OCI_RUNTIME = previousOci;
    await docker.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

function restartTestRunner(
  docker: ReturnType<typeof fakeDurableDocker>,
  tmp: string,
  stale: DetachedSessionHandle,
  onStore: (handle: DetachedSessionHandle | null) => void
) {
  let stored: DetachedSessionHandle | null = stale;
  return new DurableContainerRunner(
    {
      workspaceDocumentId: "doc1",
      containerName: "gdocs-durable-doc1",
      hostname: "dev.example.com",
      appPort: 3000,
      hostPort: 16001,
      innerDocker: false,
      sessionsRootHostPath: path.join(tmp, "sessions")
    },
    {
      docker: docker.ops,
      clientFactory: (baseUrl, secret) => createAgentSessionClient({ baseUrl, secret }),
      handleStore: {
        async load() {
          return stored;
        },
        async save(_id, handle) {
          stored = handle;
          onStore(handle);
        }
      },
      readyTimeoutMs: 2_000,
      readyPollMs: 50,
      busyPollMs: 20
    }
  );
}

/** A loopback port with nothing behind it (what a stale endpoint looks like after a restart). */
async function deadPort(): Promise<number> {
  const probe = net.createServer();
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, "127.0.0.1", () => resolve((probe.address() as net.AddressInfo).port));
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test("durable runner: a container the engine restarted is re-adopted under its new session port, not recreated", async () => {
  // `--restart unless-stopped` brings the container back after a docker/host
  // restart with a NEW ephemeral session port. The stored endpoint is dark, but
  // the container (and the workspace state in it) is fine; destroying it would
  // take the agent's app down for nothing.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "durable-test-"));
  const docker = fakeDurableDocker();
  const secret = "restart-secret";
  const newPort = await docker.bootRestarted(secret);
  const stale: DetachedSessionHandle = {
    containerId: "durable-container-1",
    endpoint: `http://127.0.0.1:${await deadPort()}`,
    secret
  };
  const saved: Array<DetachedSessionHandle | null> = [];
  const events: string[] = [];
  const runner = restartTestRunner(docker, tmp, stale, (h) => saved.push(h));
  const previousOci = process.env.AGENT_CONTAINER_OCI_RUNTIME;
  process.env.AGENT_CONTAINER_OCI_RUNTIME = "runc";
  try {
    const output = await runner.run({ workspacePath: path.join(tmp, "repo") } as never, {
      agentConfig: { model: "claude-sonnet-5" },
      agentEnv: { ANTHROPIC_API_KEY: "sk-test" },
      documentId: "doc1",
      sessionDirHostPath: path.join(tmp, "sessions", "conv-1"),
      onProgress: (event: { role: string; message: string }) => {
        events.push(event.message);
      }
    } as never);
    assert.deepEqual(output, { reply: "done 1" });
    assert.equal(docker.started.length, 0, "the running container must not be recreated");
    assert.deepEqual(docker.removed, [], "the running container must not be removed");
    assert.equal(docker.jobs.length, 1);
    // The handle now points at the new port, same id and secret.
    const last = saved[saved.length - 1];
    assert.equal(last?.endpoint, `http://127.0.0.1:${newPort}`);
    assert.equal(last?.containerId, "durable-container-1");
    assert.equal(last?.secret, secret);
    // Everyone learns the in-memory state is gone: the timeline and the agent.
    assert.ok(events.includes(DURABLE_CONTAINER_RESTARTED_MESSAGE));
    const env = docker.jobs[0].agentEnv as Record<string, string>;
    assert.match(env.GDOCS_CONTAINER_RESTARTED_AT, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(env.GDOCS_APP_PORT, "3000");
  } finally {
    if (previousOci === undefined) delete process.env.AGENT_CONTAINER_OCI_RUNTIME;
    else process.env.AGENT_CONTAINER_OCI_RUNTIME = previousOci;
    await docker.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("durable runner: a stored handle whose container is really gone leads to a recreate", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "durable-test-"));
  const docker = fakeDurableDocker(); // nothing running: hostPort throws like `docker port` on a missing container
  const stale: DetachedSessionHandle = {
    containerId: "old-container",
    endpoint: `http://127.0.0.1:${await deadPort()}`,
    secret: "old-secret"
  };
  const events: string[] = [];
  const runner = restartTestRunner(docker, tmp, stale, () => {});
  const previousOci = process.env.AGENT_CONTAINER_OCI_RUNTIME;
  process.env.AGENT_CONTAINER_OCI_RUNTIME = "runc";
  try {
    const output = await runner.run({ workspacePath: path.join(tmp, "repo") } as never, {
      agentConfig: { model: "claude-sonnet-5" },
      agentEnv: { ANTHROPIC_API_KEY: "sk-test" },
      documentId: "doc1",
      sessionDirHostPath: path.join(tmp, "sessions", "conv-1"),
      onProgress: (event: { role: string; message: string }) => {
        events.push(event.message);
      }
    } as never);
    assert.deepEqual(output, { reply: "done 1" });
    assert.equal(docker.started.length, 1, "a gone container is recreated");
    assert.deepEqual(docker.removed, ["gdocs-durable-doc1"], "leftovers under the name are cleared first");
    assert.ok(!events.includes(DURABLE_CONTAINER_RESTARTED_MESSAGE), "a recreate is not a restart");
    assert.equal((docker.jobs[0].agentEnv as Record<string, string>).GDOCS_CONTAINER_RESTARTED_AT, undefined);
  } finally {
    if (previousOci === undefined) delete process.env.AGENT_CONTAINER_OCI_RUNTIME;
    else process.env.AGENT_CONTAINER_OCI_RUNTIME = previousOci;
    await docker.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
