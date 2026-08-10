// Host-side driver for detached session containers: spawn, persist-before-work,
// consume frames, cross-process steering/cancel, adoption after the starting
// process is gone, and release.
//
// The docker interface is injected, so "the container" here is a REAL session
// server (agent-core/session-server.ts) listening on loopback in this process.
// No Docker, no LLM — but the whole host code path is exercised for real.

import assert from "node:assert/strict";
import test from "node:test";

import { createAgentSessionState, type AgentSessionFrameBody } from "../agent-core/session-protocol";
import { createAgentSessionServer } from "../agent-core/session-server";
import {
  attachDetachedSession,
  generateSessionSecret,
  runDetachedSession,
  SessionAbortedError,
  type DetachedDockerOps,
  type DetachedSessionHandle
} from "../lib/agent-runner/container-session";
import { injectRunMessage, isSteerableAiRun } from "../lib/agent-runner/run-registry";

const SECRET = "container-secret";
const PORT = 8787;

type FakeContainer = {
  id: string;
  port: number;
  emit: (frame: AgentSessionFrameBody) => void;
  close: () => Promise<void>;
  jobs: unknown[];
  messages: string[];
  cancels: number;
  exits: string[];
};

/** A fake docker whose "containers" are real in-process session servers. */
function fakeDocker(options?: { onJob?: (container: FakeContainer, job: unknown) => void }) {
  const containers: FakeContainer[] = [];
  const removed: string[] = [];
  let seq = 0;

  const ops: DetachedDockerOps = {
    async start() {
      const state = createAgentSessionState();
      const id = `abcdef01234${++seq}`;
      const container: FakeContainer = {
        id,
        port: 0,
        emit: () => {},
        close: async () => {},
        jobs: [],
        messages: [],
        cancels: 0,
        exits: []
      };
      const server = createAgentSessionServer({
        state,
        secret: SECRET,
        sweepIntervalMs: 0,
        handlers: {
          onJob: (job) => {
            container.jobs.push(job);
            options?.onJob?.(container, job);
          },
          onMessage: (text) => (container.messages.push(text), true),
          onCancel: () => {
            container.cancels += 1;
          },
          onExit: (reason) => container.exits.push(reason)
        }
      });
      container.port = await server.listen(0, "127.0.0.1");
      container.emit = (frame) => server.emit(frame);
      container.close = () => server.close();
      containers.push(container);
      return id;
    },
    async hostPort(containerId) {
      const container = containers.find((c) => c.id === containerId);
      if (!container) throw new Error("no such container");
      return container.port;
    },
    async remove(containerId) {
      removed.push(containerId);
      const container = containers.find((c) => c.id === containerId);
      await container?.close();
    }
  };

  return {
    ops,
    containers,
    removed,
    last: () => containers[containers.length - 1],
    closeAll: async () => {
      for (const container of containers) await container.close();
    }
  };
}

test("a detached run is recorded before any work starts, then driven to its result", async () => {
  const started: DetachedSessionHandle[] = [];
  const cursors: number[] = [];
  let jobPostedAfterPersist = false;

  const docker = fakeDocker({
    onJob: (container) => {
      // The handle must already be persisted by the time the job lands: a
      // container that is running while nothing durable knows how to reach it is
      // precisely the "what is even running?" failure this design removes.
      jobPostedAfterPersist = started.length === 1;
      container.emit({ type: "progress", event: { role: "assistant", message: "working" } });
      container.emit({ type: "session", sessionId: "sess-1" });
      container.emit({ type: "result", output: { replacementText: "done" } });
    }
  });

  const progress: string[] = [];
  const sessionIds: string[] = [];
  try {
    const output = await runDetachedSession({
      docker: docker.ops,
      args: ["run", "--rm", "-d", "gdocs-agent:local"],
      containerPort: PORT,
      secret: SECRET,
      job: { input: { instruction: "go" } },
      waitMs: 500,
      sink: {
        onProgress: (event) => void progress.push(String((event as { message?: unknown }).message)),
        onSessionId: (id) => void sessionIds.push(id)
      },
      store: {
        onStarted: (handle) => void started.push(handle),
        onCursor: (cursor) => void cursors.push(cursor)
      }
    });

    assert.equal(jobPostedAfterPersist, true);
    assert.equal(started.length, 1);
    assert.match(started[0].endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(started[0].secret, SECRET);
    assert.equal(started[0].containerId, docker.last().id);

    assert.deepEqual(output, { replacementText: "done" });
    assert.deepEqual(progress, ["working"]);
    assert.deepEqual(sessionIds, ["sess-1"]);
    assert.equal(cursors.at(-1), 3, "the frame cursor must reach the terminal frame");

    // Released only after the outcome was in hand — that ordering is what makes a
    // result survive the process that started the run.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(docker.last().exits, ["released"]);
    assert.deepEqual(docker.removed, [], "a released container exits by itself; no force removal");
  } finally {
    await docker.closeAll();
  }
});

test("a container we failed to record is removed instead of left orphaned", async () => {
  const docker = fakeDocker();
  try {
    await assert.rejects(
      () =>
        runDetachedSession({
          docker: docker.ops,
          args: ["run", "-d", "image"],
          containerPort: PORT,
          secret: SECRET,
          job: {},
          store: {
            onStarted: () => {
              throw new Error("database is down");
            }
          }
        }),
      /database is down/
    );
    assert.deepEqual(docker.removed, [docker.last().id]);
  } finally {
    await docker.closeAll();
  }
});

test("a newer process adopts a live run from the persisted handle and cursor", async () => {
  const docker = fakeDocker();
  try {
    // Process A: starts the container, sees the first frame, then dies.
    const containerId = await docker.ops.start(["run", "-d", "image"]);
    const port = await docker.ops.hostPort(containerId, PORT);
    const container = docker.last();
    const handle: DetachedSessionHandle = {
      containerId,
      endpoint: `http://127.0.0.1:${port}`,
      secret: SECRET
    };

    await attachDetachedSession({
      handle,
      job: { input: { instruction: "long" } },
      since: 0,
      waitMs: 50,
      signal: AbortSignal.abort(),
      sink: {}
    }).catch(() => null);
    container.emit({ type: "progress", event: { role: "assistant", message: "step 1" } });

    // Process B: nothing but the handle and the cursor A had persisted (0).
    const seen: string[] = [];
    const adopted = attachDetachedSession({
      handle,
      since: 0,
      waitMs: 2_000,
      sink: { onProgress: (event) => void seen.push(String((event as { message?: unknown }).message)) }
    });
    setTimeout(() => {
      container.emit({ type: "progress", event: { role: "assistant", message: "step 2" } });
      container.emit({ type: "result", output: { reply: "adopted" } });
    }, 30);

    assert.deepEqual(await adopted, { reply: "adopted" });
    assert.deepEqual(seen, ["step 1", "step 2"]);
    assert.equal(container.jobs.length, 1, "adoption must never start a second agent turn");
  } finally {
    await docker.closeAll();
  }
});

test("a resumed run does not replay frames the previous process already persisted", async () => {
  const docker = fakeDocker();
  try {
    const containerId = await docker.ops.start(["run", "-d", "image"]);
    const container = docker.last();
    const handle: DetachedSessionHandle = {
      containerId,
      endpoint: `http://127.0.0.1:${await docker.ops.hostPort(containerId, PORT)}`,
      secret: SECRET
    };
    container.emit({ type: "progress", event: { role: "assistant", message: "already persisted" } });
    container.emit({ type: "result", output: { ok: true } });

    const seen: string[] = [];
    await attachDetachedSession({
      handle,
      since: 1,
      waitMs: 500,
      sink: { onProgress: (event) => void seen.push(String((event as { message?: unknown }).message)) }
    });
    assert.deepEqual(seen, []);
  } finally {
    await docker.closeAll();
  }
});

test("steering reaches the container from whichever process holds the handle", async () => {
  const docker = fakeDocker();
  try {
    const containerId = await docker.ops.start(["run", "-d", "image"]);
    const container = docker.last();
    const handle: DetachedSessionHandle = {
      containerId,
      endpoint: `http://127.0.0.1:${await docker.ops.hostPort(containerId, PORT)}`,
      secret: SECRET
    };

    const runId = "run-steer-1";
    const pending = attachDetachedSession({
      handle,
      job: {},
      since: 0,
      waitMs: 2_000,
      steerRunId: runId,
      sink: {}
    });

    // Wait for the injector registration (it happens after attach/postJob).
    for (let i = 0; i < 50 && !isSteerableAiRun(runId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(isSteerableAiRun(runId), true, "a detached run must be steerable");
    assert.equal(injectRunMessage(runId, "more context"), true);

    for (let i = 0; i < 50 && container.messages.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(container.messages, ["more context"]);

    container.emit({ type: "result", output: {} });
    await pending;
    assert.equal(isSteerableAiRun(runId), false, "the injector must not outlive the run");
  } finally {
    await docker.closeAll();
  }
});

test("cancelling asks the container to stop instead of killing it from outside", async () => {
  const docker = fakeDocker();
  try {
    const containerId = await docker.ops.start(["run", "-d", "image"]);
    const container = docker.last();
    const handle: DetachedSessionHandle = {
      containerId,
      endpoint: `http://127.0.0.1:${await docker.ops.hostPort(containerId, PORT)}`,
      secret: SECRET
    };

    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = attachDetachedSession({
      handle,
      job: {},
      since: 0,
      // A long poll window on purpose: a cancel must cut the in-flight poll
      // short, not be delivered whenever the window happens to expire.
      waitMs: 20_000,
      signal: controller.signal,
      sink: {}
    });
    setTimeout(() => controller.abort(), 40);

    await assert.rejects(() => pending, SessionAbortedError);
    assert.ok(Date.now() - startedAt < 5_000, "cancellation must not wait out the long-poll window");
    for (let i = 0; i < 50 && container.cancels === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(container.cancels, 1, "cancellation is in-container: a detached run has no parent to signal");
    assert.deepEqual(docker.removed, []);
  } finally {
    await docker.closeAll();
  }
});

test("a terminal error frame fails the run with the agent's own message", async () => {
  const docker = fakeDocker({
    onJob: (container) => container.emit({ type: "error", message: "agent could not start" })
  });
  try {
    await assert.rejects(
      () =>
        runDetachedSession({
          docker: docker.ops,
          args: ["run", "-d", "image"],
          containerPort: PORT,
          secret: SECRET,
          job: {},
          waitMs: 500
        }),
      /agent could not start/
    );
  } finally {
    await docker.closeAll();
  }
});

test("comments with no live handler are folded into the run output, not dropped", async () => {
  const docker = fakeDocker({
    onJob: (container) => {
      container.emit({ type: "comment", comment: { findText: "here", body: "note" } });
      container.emit({ type: "result", output: { replacementText: "x" } });
    }
  });
  try {
    const output = await runDetachedSession({
      docker: docker.ops,
      args: ["run", "-d", "image"],
      containerPort: PORT,
      secret: SECRET,
      job: {},
      waitMs: 500
    });
    assert.deepEqual(output.comments, [{ findText: "here", body: "note" }]);
  } finally {
    await docker.closeAll();
  }
});

test("the per-container secret is long, random and unique", () => {
  const a = generateSessionSecret();
  const b = generateSessionSecret();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40, a);
  assert.match(a, /^[A-Za-z0-9_-]+$/, "must be safe in an env-file line");
});
