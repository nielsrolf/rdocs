// The durable side of a detached session run: what the host writes about a
// container, when, and what it stops advertising once the container is gone.
//
// The Prisma write is injected, so this exercises the ordering/throttling policy
// without touching the production database.

import assert from "node:assert/strict";
import test from "node:test";

import { createAiRunSessionStore, detachedContainersEnabled } from "../lib/agent-runner/session-store";

function recorder() {
  const writes: Array<Record<string, unknown>> = [];
  return {
    writes,
    update: async (data: Record<string, unknown>) => void writes.push(data)
  };
}

test("the handle is written in full before the job can start", async () => {
  const rec = recorder();
  const store = createAiRunSessionStore("run-1", { update: rec.update });
  await store.onStarted?.({ containerId: "abc123", endpoint: "http://127.0.0.1:5001", secret: "s3cret" });

  assert.deepEqual(rec.writes, [
    {
      containerId: "abc123",
      sessionEndpoint: "http://127.0.0.1:5001",
      sessionSecret: "s3cret",
      frameCursor: 0
    }
  ]);
});

test("cursor writes are throttled but never lose the newest value", async () => {
  const rec = recorder();
  let now = 1_000;
  const store = createAiRunSessionStore("run-1", {
    update: rec.update,
    now: () => now,
    cursorIntervalMs: 1_000
  });

  await store.onCursor?.(1); // first write always goes through
  await store.onCursor?.(2); // same millisecond → throttled
  await store.onCursor?.(3);
  now += 1_500;
  await store.onCursor?.(4);

  assert.deepEqual(
    rec.writes.map((w) => w.frameCursor),
    [1, 4]
  );

  // A run that ends mid-throttle-window must still persist where it got to,
  // otherwise an adopting process replays frames it already applied.
  await store.onFinished?.({ containerId: "abc123", endpoint: "http://127.0.0.1:5001", secret: "s3cret" });
  assert.equal(rec.writes.at(-1)?.sessionEndpoint, null);
});

test("a released container stops being advertised as attachable", async () => {
  const rec = recorder();
  const store = createAiRunSessionStore("run-1", { update: rec.update });
  await store.onFinished?.({ containerId: "abc123", endpoint: "http://127.0.0.1:5001", secret: "s3cret" });

  const last = rec.writes.at(-1)!;
  // containerId stays for cleanup/forensics; endpoint+secret go, so neither
  // adoption on boot nor the reaper tries to talk to a container that is exiting.
  assert.equal(last.containerId, undefined);
  assert.equal(last.sessionEndpoint, null);
  assert.equal(last.sessionSecret, null);
});

test("a cursor that did not advance is not rewritten", async () => {
  const rec = recorder();
  let now = 0;
  const store = createAiRunSessionStore("run-1", { update: rec.update, now: () => now, cursorIntervalMs: 0 });
  await store.onCursor?.(5);
  now += 10;
  await store.onCursor?.(5);
  assert.equal(rec.writes.length, 1);
});

test("a store with no run id is a no-op rather than a crash", async () => {
  const rec = recorder();
  const store = createAiRunSessionStore(undefined, { update: rec.update });
  await store.onStarted?.({ containerId: "abc", endpoint: "http://x", secret: "y" });
  await store.onCursor?.(3);
  await store.onFinished?.({ containerId: "abc", endpoint: "http://x", secret: "y" });
  assert.deepEqual(rec.writes, []);
});

test("detached containers are opt-in and explicitly switchable", () => {
  assert.equal(detachedContainersEnabled({}), false);
  assert.equal(detachedContainersEnabled({ AGENT_DETACHED_CONTAINERS: "1" }), true);
  assert.equal(detachedContainersEnabled({ AGENT_DETACHED_CONTAINERS: "true" }), true);
  assert.equal(detachedContainersEnabled({ AGENT_DETACHED_CONTAINERS: "0" }), false);
  assert.equal(detachedContainersEnabled({ AGENT_DETACHED_CONTAINERS: "false" }), false);
});
