import assert from "node:assert/strict";
import test from "node:test";

import { buildContainerRunArgs } from "../lib/agent-runner/container-args";
import {
  RUN_CANCELLED_MESSAGE,
  RUN_REGISTRY_GLOBAL_KEY,
  RunCancelledError,
  activeRunCount,
  cancelAiRun,
  deregisterRunAbortController,
  injectRunMessage,
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

// Next.js evaluates `instrumentation.ts` (Slack socket + scheduler) and the App
// Router route handlers in SEPARATE module contexts, so a module-local Map gave
// each context its own registry: a Slack-triggered run registered in the
// instrumentation copy was invisible to the route handler's copy — cancel
// returned 409 "not owned by the current server process", /api/health reported
// activeRuns: 0, and the blue/green drain therefore exited immediately and
// killed in-flight Slack runs. The registry must live on a globalThis slot so
// every module instance in the process shares one view.
test("the run registry is shared across module instances of the same process", () => {
  const registry = (globalThis as Record<string, unknown>)[RUN_REGISTRY_GLOBAL_KEY] as
    | { controllers: Map<string, AbortController>; injectors: Map<string, (text: string) => boolean> }
    | undefined;
  assert.ok(registry, "registry is published on globalThis");
  assert.ok(registry.controllers instanceof Map);
  assert.ok(registry.injectors instanceof Map);

  // Stand in for "another module instance registered this run": write straight
  // into the shared slot, then use the public API from this instance.
  const foreign = new AbortController();
  registry.controllers.set("foreign-run", foreign);
  registry.injectors.set("foreign-run", () => true);
  try {
    assert.equal(isCancellableAiRun("foreign-run"), true, "sees a run registered by another instance");
    assert.ok(activeRunCount() >= 1, "drain criterion counts cross-instance runs");
    assert.equal(injectRunMessage("foreign-run", "hello"), true, "steering reaches cross-instance runs");
    assert.equal(cancelAiRun("foreign-run"), true);
    assert.equal(foreign.signal.aborted, true, "cancel aborts the other instance's controller");
  } finally {
    registry.controllers.delete("foreign-run");
    registry.injectors.delete("foreign-run");
  }
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
