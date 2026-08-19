// End-to-end test of the detached session transport: the real HTTP server that
// runs inside the container, driven by the real host client over loopback. No
// Docker, no LLM — this covers exactly the part that used to be the stdio pipe.

import assert from "node:assert/strict";
import test from "node:test";

import { createAgentSessionState } from "../agent-core/session-protocol";
import { createAgentSessionServer, MAX_SESSION_BODY_BYTES } from "../agent-core/session-server";
import {
  AttachSupersededError,
  consumeAgentSession,
  createAgentSessionClient
} from "../lib/agent-runner/session-client";

const SECRET = "test-secret";

async function startSession(overrides?: {
  onMessage?: (text: string) => boolean;
  onCancel?: () => void;
  stateOptions?: Parameters<typeof createAgentSessionState>[0];
}) {
  const state = createAgentSessionState(overrides?.stateOptions);
  const jobs: unknown[] = [];
  const messages: string[] = [];
  const exits: string[] = [];
  let cancelled = 0;
  const server = createAgentSessionServer({
    state,
    secret: SECRET,
    sweepIntervalMs: 0,
    handlers: {
      onJob: (job) => jobs.push(job),
      onMessage: overrides?.onMessage ?? ((text) => (messages.push(text), true)),
      onCancel: overrides?.onCancel ?? (() => (cancelled += 1)),
      onExit: (reason) => exits.push(reason)
    }
  });
  const port = await server.listen(0, "127.0.0.1");
  const client = createAgentSessionClient({ baseUrl: `http://127.0.0.1:${port}`, secret: SECRET });
  return {
    state,
    server,
    client,
    port,
    jobs,
    messages,
    exits,
    cancelledCount: () => cancelled,
    newClient: () => createAgentSessionClient({ baseUrl: `http://127.0.0.1:${port}`, secret: SECRET })
  };
}

test("a full run flows over the session transport: attach, job, frames, result", async () => {
  const session = await startSession();
  try {
    const attached = await session.client.attach();
    assert.equal(attached.phase, "awaiting_job");
    assert.equal(attached.lastSeq, 0);

    assert.equal(await session.client.postJob({ input: { instruction: "do it" } }), true);
    assert.deepEqual(session.jobs, [{ input: { instruction: "do it" } }]);

    // The agent side emits through the server so long-polls wake immediately.
    session.server.emit({ type: "progress", event: { role: "assistant", message: "thinking" } });
    session.server.emit({ type: "result", output: { replacementText: "hello" } });

    const seen: string[] = [];
    const outcome = await consumeAgentSession({
      client: session.client,
      since: 0,
      waitMs: 1_000,
      onFrame: (frame) => void seen.push(frame.type)
    });

    assert.deepEqual(seen, ["progress", "result"]);
    assert.equal(outcome.kind, "result");
    assert.deepEqual(outcome.kind === "result" ? outcome.output : null, { replacementText: "hello" });
    assert.equal(outcome.cursor, 2);
  } finally {
    await session.server.close();
  }
});

test("a second process attaches to the same container and resumes from the persisted cursor", async () => {
  const session = await startSession();
  try {
    // Process A starts the run and persists frames up to cursor 1.
    await session.client.attach();
    await session.client.postJob({ input: { instruction: "long job" } });
    session.server.emit({ type: "progress", event: { role: "assistant", message: "step 1" } });

    const seenByA: number[] = [];
    let cursorA = 0;
    const batchA = await session.client.frames(0, 0);
    for (const frame of batchA.frames) {
      seenByA.push(frame.seq);
      cursorA = frame.seq;
    }
    assert.deepEqual(seenByA, [1]);

    // …then process A dies (a deploy). Process B attaches with only the cursor.
    const clientB = session.newClient();
    const attachedB = await clientB.attach();
    assert.equal(attachedB.phase, "running", "the run is still going inside the container");

    // The job must NOT be started a second time by the new owner.
    assert.equal(await clientB.postJob({ input: { instruction: "long job" } }), false);
    assert.equal(session.jobs.length, 1);

    session.server.emit({ type: "progress", event: { role: "assistant", message: "step 2" } });
    session.server.emit({ type: "result", output: { replacementText: "finished" } });

    const seenByB: number[] = [];
    const outcome = await consumeAgentSession({
      client: clientB,
      since: cursorA,
      waitMs: 1_000,
      onFrame: (frame) => void seenByB.push(frame.seq)
    });

    assert.deepEqual(seenByB, [2, 3], "frame 1 was already persisted and must not be replayed");
    assert.equal(outcome.kind, "result");
    assert.deepEqual(outcome.kind === "result" ? outcome.output : null, { replacementText: "finished" });
  } finally {
    await session.server.close();
  }
});

test("the superseded process is rejected instead of racing the new one", async () => {
  const session = await startSession();
  try {
    const clientA = session.client;
    await clientA.attach();
    await clientA.postJob({ input: {} });

    const clientB = session.newClient();
    await clientB.attach();

    await assert.rejects(() => clientA.frames(0, 0), AttachSupersededError);
    await assert.rejects(() => clientA.message("steer me"), AttachSupersededError);

    // The new owner works normally.
    session.server.emit({ type: "progress", event: { role: "assistant", message: "b owns it" } });
    const batch = await clientB.frames(0, 0);
    assert.equal(batch.frames.length, 1);
  } finally {
    await session.server.close();
  }
});

test("steering and cancellation reach the live turn from any attached process", async () => {
  const session = await startSession();
  try {
    await session.client.attach();
    await session.client.postJob({ input: {} });

    assert.equal(await session.client.message("extra context"), true);
    assert.deepEqual(session.messages, ["extra context"]);

    await session.client.cancel();
    assert.equal(session.cancelledCount(), 1);
  } finally {
    await session.server.close();
  }
});

test("steering that the turn cannot accept reports undelivered so the host queues", async () => {
  const session = await startSession({ onMessage: () => false });
  try {
    await session.client.attach();
    await session.client.postJob({ input: {} });
    assert.equal(await session.client.message("too late"), false);
  } finally {
    await session.server.close();
  }
});

test("a long-poll returns as soon as a frame is emitted", async () => {
  const session = await startSession();
  try {
    await session.client.attach();
    await session.client.postJob({ input: {} });

    const pending = session.client.frames(0, 5_000);
    setTimeout(() => session.server.emit({ type: "progress", event: { role: "assistant", message: "late" } }), 50);
    const batch = await pending;
    assert.equal(batch.frames.length, 1);
    assert.equal(batch.done, false);
  } finally {
    await session.server.close();
  }
});

test("requests without the container secret are rejected", async () => {
  const session = await startSession();
  try {
    const response = await fetch(`http://127.0.0.1:${session.port}/status`);
    assert.equal(response.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${session.port}/status`, {
      headers: { authorization: "Bearer nope" }
    });
    assert.equal(wrong.status, 401);
  } finally {
    await session.server.close();
  }
});

test("release lets the container exit once the host has persisted the result", async () => {
  const session = await startSession();
  try {
    await session.client.attach();
    await session.client.postJob({ input: {} });
    session.server.emit({ type: "result", output: {} });
    await session.client.release();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(session.exits, ["released"]);
  } finally {
    await session.server.close();
  }
});

test("a terminal error frame is an outcome, not a transport failure", async () => {
  const session = await startSession();
  try {
    await session.client.attach();
    await session.client.postJob({ input: {} });
    session.server.emit({ type: "error", message: "agent blew up" });
    const outcome = await consumeAgentSession({
      client: session.client,
      since: 0,
      waitMs: 500,
      onFrame: () => {}
    });
    assert.equal(outcome.kind, "error");
    assert.equal(outcome.kind === "error" ? outcome.message : null, "agent blew up");
  } finally {
    await session.server.close();
  }
});

test("a transport blip is retried, not turned into a failed run", async () => {
  const session = await startSession();
  try {
    await session.client.attach();
    await session.client.postJob({ input: {} });
    session.server.emit({ type: "result", output: { ok: true } });

    let calls = 0;
    const flaky = {
      ...session.client,
      frames: async (since: number, waitMs?: number) => {
        calls += 1;
        if (calls === 1) throw new Error("ECONNRESET");
        return session.client.frames(since, waitMs);
      }
    };
    const outcome = await consumeAgentSession({
      client: flaky,
      since: 0,
      waitMs: 500,
      onFrame: () => {},
      sleepImpl: async () => {}
    });
    assert.equal(calls, 2);
    assert.equal(outcome.kind, "result");
  } finally {
    await session.server.close();
  }
});

test("a liveness probe reads status without resetting the no-contact TTL", async () => {
  // The reaper probes an orphaned run's container on every sweep. If that
  // counted as contact, the container would never reach its own no-contact TTL
  // and an orphan nobody adopts would live forever — kept alive by the very
  // check meant to detect that nobody is driving it.
  const session = await startSession();
  try {
    const before = (await session.client.status()).lastContactAtMs;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const probed = await session.client.status(true);
    assert.equal(probed.lastContactAtMs, before, "probe=1 must not count as contact");

    await new Promise((resolve) => setTimeout(resolve, 5));
    const touched = await session.client.status();
    assert.ok(touched.lastContactAtMs > before, "a plain status read is still contact");
  } finally {
    await session.server.close();
  }
});

// A document with pasted images ships its image blocks (data URLs) inside the
// job, so a perfectly ordinary selection edit can post several megabytes. The
// original 4 MiB cap rejected the body by DESTROYING the socket mid-upload, so
// undici reported the opaque "fetch failed" and the run died with a message
// that pointed at nothing (2026-08-12: two selection edits on a 6 MB document).
test("a multi-megabyte job (document with pasted images) is accepted", async () => {
  const session = await startSession();
  try {
    await session.client.attach();
    const bigImage = "data:image/png;base64," + "A".repeat(6 * 1024 * 1024);
    const job = { input: { instruction: "fix the latex", documentBlocks: [{ type: "image", src: bigImage }] } };
    assert.equal(await session.client.postJob(job), true);
    assert.equal(session.jobs.length, 1);
    assert.deepEqual(session.jobs[0], job);
  } finally {
    await session.server.close();
  }
});

test("an over-limit job body fails with an actionable HTTP error, not a destroyed socket", async () => {
  const session = await startSession();
  try {
    await session.client.attach();
    const oversize = "x".repeat(MAX_SESSION_BODY_BYTES + 1024);
    await assert.rejects(
      () => session.client.postJob({ input: { instruction: oversize } }),
      (error: Error) => {
        assert.ok(
          /413/.test(error.message),
          `expected an HTTP 413, got: ${error.message}`
        );
        return true;
      }
    );
  } finally {
    await session.server.close();
  }
});
