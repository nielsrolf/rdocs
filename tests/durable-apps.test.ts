// Durable app mode (lib/durable-apps.ts + lib/agent-runner/durable.ts): pure
// validation helpers, the container args a durable container gets, and the
// runner driving two consecutive jobs through ONE real (in-process) durable
// session server via a fake docker. No Docker, no LLM, no DB.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

/** Fake docker: `start` boots a REAL durable session server, secret read from the env file in argv. */
function fakeDurableDocker() {
  const started: string[][] = [];
  const removed: string[] = [];
  const jobs: Array<Record<string, unknown>> = [];
  let server: ReturnType<typeof createAgentSessionServer> | null = null;
  let emit: (frame: Parameters<ReturnType<typeof createAgentSessionServer>["emit"]>[0]) => void = () => {};
  const ops: DetachedDockerOps = {
    async start(args) {
      started.push(args);
      const envFile = args[args.indexOf("--env-file") + 1];
      const secret = (await readFile(envFile, "utf8"))
        .split("\n")
        .find((line) => line.startsWith(`${AGENT_SESSION_SECRET_ENV}=`))!
        .slice(AGENT_SESSION_SECRET_ENV.length + 1);
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
      const port = await server.listen(0, "127.0.0.1");
      (ops as { port?: number }).port = port;
      return "durable-container-1";
    },
    async hostPort() {
      return (ops as { port?: number }).port!;
    },
    async remove(id) {
      removed.push(id);
    }
  };
  return { ops, started, removed, jobs, close: async () => server?.close() };
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
