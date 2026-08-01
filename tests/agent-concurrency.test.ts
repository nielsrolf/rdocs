import assert from "node:assert/strict";
import { test } from "node:test";

import { RunSlotSemaphore, resolveAgentRunLimit } from "../lib/agent-runner/concurrency";

const tick = () => new Promise<void>((r) => setImmediate(r));

test("never grants more slots than the limit; queued acquires run FIFO", async () => {
  const sem = new RunSlotSemaphore(2);
  let peak = 0;
  let active = 0;
  const order: number[] = [];

  const run = async (i: number) => {
    const release = await sem.acquire();
    order.push(i);
    active += 1;
    peak = Math.max(peak, active);
    await tick();
    active -= 1;
    release();
  };

  await Promise.all([run(0), run(1), run(2), run(3), run(4)]);
  assert.equal(peak, 2);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
  assert.equal(sem.activeCount, 0);
  assert.equal(sem.queuedCount, 0);
});

test("release is idempotent", async () => {
  const sem = new RunSlotSemaphore(1);
  const release = await sem.acquire();
  release();
  release();
  assert.equal(sem.activeCount, 0);
  const again = await sem.acquire();
  assert.equal(sem.activeCount, 1);
  again();
});

test("aborting while queued rejects and gives up the queue position", async () => {
  const sem = new RunSlotSemaphore(1);
  const release = await sem.acquire();

  const cancelled = new AbortController();
  const queuedCancelled = sem.acquire(cancelled.signal);
  const queuedSurvivor = sem.acquire();
  assert.equal(sem.queuedCount, 2);

  cancelled.abort(new Error("user cancelled"));
  await assert.rejects(queuedCancelled, /user cancelled/);
  assert.equal(sem.queuedCount, 1);

  // The survivor gets the slot when the holder releases — the aborted waiter
  // does not consume it.
  release();
  const releaseSurvivor = await queuedSurvivor;
  assert.equal(sem.activeCount, 1);
  releaseSurvivor();
  assert.equal(sem.activeCount, 0);
});

test("acquire on an already-aborted signal rejects immediately", async () => {
  const sem = new RunSlotSemaphore(1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sem.acquire(controller.signal));
  assert.equal(sem.activeCount, 0);
});

test("resolveAgentRunLimit parses the env var with a safe default", () => {
  assert.equal(resolveAgentRunLimit("6"), 6);
  assert.equal(resolveAgentRunLimit("1"), 1);
  assert.equal(resolveAgentRunLimit(undefined), 4);
  assert.equal(resolveAgentRunLimit(""), 4);
  assert.equal(resolveAgentRunLimit("0"), 4);
  assert.equal(resolveAgentRunLimit("-3"), 4);
  assert.equal(resolveAgentRunLimit("banana"), 4);
});
