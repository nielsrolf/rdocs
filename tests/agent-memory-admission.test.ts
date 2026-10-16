import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dockerMemoryProbe,
  MemoryAdmission,
  parseMemorySize,
  resolveMemoryAdmissionConfig,
  type RunContainer
} from "../lib/agent-runner/memory-admission";

const GiB = 1024 ** 3;
const tick = () => new Promise<void>((r) => setImmediate(r));
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await tick();
};

function fakeProbe(initial: { containers?: RunContainer[]; available?: number | null } = {}) {
  const state = { containers: initial.containers ?? [], available: initial.available ?? 20 * GiB };
  return {
    state,
    probe: {
      containers: async () => state.containers,
      availableBytes: async () => state.available
    }
  };
}

function admission(probe: ReturnType<typeof fakeProbe>["probe"], budgetGiB = 20) {
  return new MemoryAdmission({
    budgetBytes: budgetGiB * GiB,
    minAvailableBytes: 3 * GiB,
    unlimitedContainerBytes: 6 * GiB,
    probe,
    pollMs: 10
  });
}

test("parseMemorySize understands docker-style sizes", () => {
  assert.equal(parseMemorySize("6g"), 6 * GiB);
  assert.equal(parseMemorySize("16G"), 16 * GiB);
  assert.equal(parseMemorySize("512m"), 512 * 1024 ** 2);
  assert.equal(parseMemorySize("1.5GiB"), 1.5 * GiB);
  assert.equal(parseMemorySize("1073741824"), GiB);
  assert.equal(parseMemorySize(""), null);
  assert.equal(parseMemorySize("lots"), null);
  assert.equal(parseMemorySize(undefined), null);
});

test("the sum of granted limits never exceeds the budget; waiters start FIFO as memory frees up", async () => {
  const { probe } = fakeProbe();
  const gate = admission(probe, 20);
  const order: number[] = [];
  let reserved = 0;
  let peak = 0;
  const releases: Array<() => void> = [];

  const runs = [0, 1, 2, 3, 4].map((i) =>
    gate.admit({ name: `gdocs-run-${i}`, bytes: 6 * GiB }).then((release) => {
      order.push(i);
      reserved += 6;
      peak = Math.max(peak, reserved);
      releases[i] = () => {
        reserved -= 6;
        release();
      };
    })
  );
  await settle();
  assert.deepEqual(order, [0, 1, 2]); // 3 x 6g fit into 20g, the 4th would not
  assert.equal(gate.queuedCount, 2);

  releases[1]();
  await settle();
  assert.deepEqual(order, [0, 1, 2, 3]);

  releases[0]();
  releases[2]();
  await Promise.all(runs);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
  assert.ok(peak <= 18, `peak ${peak} GiB over budget`);
  releases[3]();
  releases[4]();
});

test("containers this process did not start (other blue/green color, durable app) count at their docker limit", async () => {
  const { probe, state } = fakeProbe({
    containers: [{ name: "gdocs-durable-x", limitBytes: 16 * GiB }]
  });
  const gate = admission(probe, 20);
  let started = false;
  const run = gate.admit({ name: "gdocs-run-a", bytes: 6 * GiB }).then((release) => {
    started = true;
    return release;
  });
  await settle();
  assert.equal(started, false, "16g durable + 6g run exceeds the 20g budget");

  // The durable container goes away (or is recreated smaller): the poll notices.
  state.containers = [{ name: "gdocs-durable-x", limitBytes: 3 * GiB }];
  const release = await run;
  assert.equal(started, true);
  release();
});

test("a granted run's own container is not counted twice", async () => {
  const { probe, state } = fakeProbe();
  const gate = admission(probe, 12);
  const releaseA = await gate.admit({ name: "gdocs-run-a", bytes: 6 * GiB });
  // Run A's container is now visible in docker with its 6g limit.
  state.containers = [{ name: "gdocs-run-a", limitBytes: 6 * GiB }];
  const releaseB = await gate.admit({ name: "gdocs-run-b", bytes: 6 * GiB });
  releaseA();
  releaseB();
});

test("a run larger than the whole budget still runs, alone", async () => {
  const { probe } = fakeProbe();
  const gate = admission(probe, 20);
  const big = await gate.admit({ name: "gdocs-run-big", bytes: 32 * GiB });
  let smallStarted = false;
  const small = gate.admit({ name: "gdocs-run-small", bytes: 1 * GiB }).then((r) => {
    smallStarted = true;
    return r;
  });
  await settle();
  assert.equal(smallStarted, false);
  big();
  (await small)();
});

test("waits while the host itself is low on memory, even with budget left", async () => {
  const { probe, state } = fakeProbe({ available: 1 * GiB });
  const gate = admission(probe, 20);
  const reasons: string[] = [];
  let started = false;
  const run = gate
    .admit({ name: "gdocs-run-a", bytes: 2 * GiB }, { onQueued: (r) => reasons.push(r) })
    .then((release) => {
      started = true;
      return release;
    });
  await settle();
  assert.equal(started, false);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /host memory is free/);

  state.available = 10 * GiB;
  (await run)();
  assert.equal(started, true);
});

test("a large run at the head of the queue is not starved by smaller ones behind it", async () => {
  const { probe } = fakeProbe();
  const gate = admission(probe, 20);
  const first = await gate.admit({ name: "gdocs-run-1", bytes: 10 * GiB });
  const order: string[] = [];
  const big = gate.admit({ name: "gdocs-run-big", bytes: 16 * GiB }).then((r) => {
    order.push("big");
    return r;
  });
  // 6g would fit next to the 10g run, but not next to the 16g one ahead of it.
  const small = gate.admit({ name: "gdocs-run-small", bytes: 6 * GiB }).then((r) => {
    order.push("small");
    return r;
  });
  await settle();
  assert.deepEqual(order, [], "small must wait behind big even though it would fit");
  first();
  const releaseBig = await big;
  await settle();
  assert.deepEqual(order, ["big"]);
  releaseBig();
  (await small)();
  assert.deepEqual(order, ["big", "small"]);
});

test("aborting while queued rejects and frees the queue position", async () => {
  const { probe } = fakeProbe();
  const gate = admission(probe, 6);
  const release = await gate.admit({ name: "gdocs-run-a", bytes: 6 * GiB });
  const controller = new AbortController();
  const cancelled = gate.admit({ name: "gdocs-run-b", bytes: 6 * GiB }, { signal: controller.signal });
  const survivor = gate.admit({ name: "gdocs-run-c", bytes: 6 * GiB });
  await settle();
  assert.equal(gate.queuedCount, 2);
  controller.abort(new Error("cancelled"));
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(gate.queuedCount, 1);
  release();
  (await survivor)();
  assert.equal(gate.queuedCount, 0);
});

test("release is idempotent", async () => {
  const { probe } = fakeProbe();
  const gate = admission(probe, 6);
  const release = await gate.admit({ name: "gdocs-run-a", bytes: 6 * GiB });
  release();
  release();
  (await gate.admit({ name: "gdocs-run-b", bytes: 6 * GiB }))();
});

test("docker probe reads running gdocs containers and their limits", async () => {
  const calls: string[][] = [];
  const probe = dockerMemoryProbe("docker", async (_cmd, args) => {
    calls.push(args);
    if (args[0] === "ps") return { code: 0, stdout: "gdocs-run-a\ngdocs-durable-x\n" };
    return { code: 0, stdout: `/gdocs-run-a|${6 * GiB}\n/gdocs-durable-x|0\n` };
  });
  assert.deepEqual(await probe.containers(), [
    { name: "gdocs-run-a", limitBytes: 6 * GiB },
    { name: "gdocs-durable-x", limitBytes: 0 }
  ]);
  assert.deepEqual(calls[0], ["ps", "--format", "{{.Names}}", "--filter", "name=^gdocs-"]);

  const down = dockerMemoryProbe("docker", async () => ({ code: 1, stdout: "" }));
  assert.equal(await down.containers(), null);
});

test("config: budget, per-run size and minimum free memory come from env", () => {
  const config = resolveMemoryAdmissionConfig({
    AGENT_CONTAINER_MEMORY: "6g",
    AGENT_MEMORY_BUDGET: "20g",
    AGENT_MIN_AVAILABLE_MEMORY: "4g"
  });
  assert.equal(config.perRunBytes, 6 * GiB);
  assert.equal(config.budgetBytes, 20 * GiB);
  assert.equal(config.minAvailableBytes, 4 * GiB);
  const defaults = resolveMemoryAdmissionConfig({});
  assert.equal(defaults.perRunBytes, 4 * GiB);
  assert.ok(defaults.budgetBytes > 0);
});
