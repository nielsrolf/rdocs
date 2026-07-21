import assert from "node:assert/strict";
import test from "node:test";

import {
  beginDrain,
  isDraining,
  drainingSince,
  resetDrainStateForTests
} from "../lib/deploy-lifecycle";

// Graceful drain for blue/green deploys: after the LB switches, the old
// process must stop taking new work, wait for its in-flight agent runs, and
// exit on its own. These tests drive the lifecycle with injected deps.

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("drain stops intake, waits for active runs, then exits 0", async () => {
  resetDrainStateForTests();
  let active = 2;
  let intakeStopped = false;
  let exitCode: number | null = null;

  assert.equal(isDraining(), false);
  assert.equal(drainingSince(), null);

  const { alreadyDraining } = beginDrain({
    stopIntake: async () => {
      intakeStopped = true;
    },
    countActiveRuns: () => active,
    exit: (code) => {
      exitCode = code;
    },
    pollMs: 20,
    graceMs: 10
  });

  assert.equal(alreadyDraining, false);
  assert.equal(isDraining(), true);
  assert.ok(drainingSince() instanceof Date);

  await waitFor(() => intakeStopped);
  // Still runs in flight — must not exit yet.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(exitCode, null, "must not exit while runs are active");

  // Runs finish one by one.
  active = 1;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(exitCode, null);
  active = 0;

  await waitFor(() => exitCode !== null);
  assert.equal(exitCode, 0);
  resetDrainStateForTests();
});

test("drain is idempotent — a second call reports alreadyDraining and starts no second loop", async () => {
  resetDrainStateForTests();
  let exits = 0;
  const deps = {
    stopIntake: async () => {},
    countActiveRuns: () => 0,
    exit: () => {
      exits += 1;
    },
    pollMs: 10,
    graceMs: 10
  };

  const first = beginDrain(deps);
  const second = beginDrain(deps);
  assert.equal(first.alreadyDraining, false);
  assert.equal(second.alreadyDraining, true);

  await waitFor(() => exits > 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(exits, 1, "only one drain loop may exit the process");
  resetDrainStateForTests();
});

test("drain gives up after maxMs even with runs still active", async () => {
  resetDrainStateForTests();
  let exitCode: number | null = null;

  beginDrain({
    stopIntake: async () => {},
    countActiveRuns: () => 5, // never drains
    exit: (code) => {
      exitCode = code;
    },
    pollMs: 15,
    maxMs: 100,
    graceMs: 5
  });

  await waitFor(() => exitCode !== null, 5000);
  assert.equal(exitCode, 0, "hard cap must still exit cleanly");
  resetDrainStateForTests();
});

test("a failing stopIntake does not abort the drain", async () => {
  resetDrainStateForTests();
  let exitCode: number | null = null;

  beginDrain({
    stopIntake: async () => {
      throw new Error("socket already gone");
    },
    countActiveRuns: () => 0,
    exit: (code) => {
      exitCode = code;
    },
    pollMs: 10,
    graceMs: 5
  });

  await waitFor(() => exitCode !== null);
  assert.equal(exitCode, 0);
  resetDrainStateForTests();
});
