import assert from "node:assert/strict";
import test from "node:test";

import { buildContainerRunArgs } from "../lib/agent-runner/container-args";
import {
  RUN_CANCELLED_MESSAGE,
  RunCancelledError,
  cancelAiRun,
  deregisterRunAbortController,
  isCancellableAiRun,
  isRunCancellation,
  registerRunAbortController
} from "../lib/agent-runner/run-registry";

// Per-run cancellation: stopping one agent must not require restarting the
// whole service (which killed every other run as collateral).

test("a registered run can be cancelled exactly while it is registered", () => {
  const controller = registerRunAbortController("run-1");
  try {
    assert.equal(isCancellableAiRun("run-1"), true);
    assert.equal(controller.signal.aborted, false);

    assert.equal(cancelAiRun("run-1"), true, "registered run is cancellable");
    assert.equal(controller.signal.aborted, true, "cancel aborts the run's signal");
    assert.ok(controller.signal.reason instanceof RunCancelledError);
  } finally {
    deregisterRunAbortController("run-1");
  }
  assert.equal(cancelAiRun("run-1"), false, "deregistered run is no longer cancellable");
});

test("cancelling an unknown run reports false instead of throwing", () => {
  assert.equal(cancelAiRun("never-registered"), false);
  assert.equal(isCancellableAiRun("never-registered"), false);
});

test("isRunCancellation recognizes cancellations however they surface", () => {
  // The killed container surfaces as an unrelated error — the aborted signal is
  // what marks it as a cancellation.
  const controller = new AbortController();
  controller.abort(new RunCancelledError());
  assert.equal(
    isRunCancellation(new Error("agent container exited without a result (exit code 137)."), controller.signal),
    true
  );

  assert.equal(isRunCancellation(new RunCancelledError(), undefined), true);
  assert.equal(isRunCancellation(new Error(RUN_CANCELLED_MESSAGE), undefined), true);

  const liveSignal = new AbortController().signal;
  assert.equal(isRunCancellation(new Error("boom"), liveSignal), false);
  assert.equal(isRunCancellation(new Error("boom"), undefined), false);
});

test("the container gets a stable --name so a cancel can docker-kill it deterministically", () => {
  const named = buildContainerRunArgs({
    image: "gdocs-agent:local",
    name: "gdocs-run-abc123",
    workspaceHostPath: "/tmp/workspace",
    envFileHostPath: "/tmp/envfile"
  });
  const nameIdx = named.indexOf("--name");
  assert.ok(nameIdx > 0, "--name flag present");
  assert.equal(named[nameIdx + 1], "gdocs-run-abc123");

  const unnamed = buildContainerRunArgs({
    image: "gdocs-agent:local",
    workspaceHostPath: "/tmp/workspace",
    envFileHostPath: "/tmp/envfile"
  });
  assert.equal(unnamed.includes("--name"), false, "no --name without a spec name");
});
