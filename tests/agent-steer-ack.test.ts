import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ContainerRunner } from "../lib/agent-runner/container";
import { injectRunMessage, isSteerableAiRun } from "../lib/agent-runner/run-registry";

// 2026-09-24 (#rl-playground, run cmufpgsjx0652nweribgdo70s): a Slack follow-up
// got 👀 ("injected") but never reached the agent. The stdio container injector
// reported success as soon as the frame was written to the container's stdin,
// while the entrypoint had already closed its input channel and only logged
// "dropped steering message" to stderr — so Slack never fell back to ⏳.
// Delivery now counts only when the container acknowledges acceptance.

const FAKE_DOCKER = path.join(__dirname, "fixtures", "fake-docker-steer.mjs");

async function steerOnce(mode: "accept" | "refuse" | "silent"): Promise<boolean> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "steer-ack-"));
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace);
  const runId = `steer-ack-${mode}-${Date.now()}`;
  const saved = {
    runtime: process.env.AGENT_CONTAINER_RUNTIME,
    mode: process.env.FAKE_STEER_MODE,
    oci: process.env.AGENT_CONTAINER_OCI_RUNTIME,
    detached: process.env.AGENT_DETACHED_CONTAINERS
  };
  // The stdio transport (`docker run -i`); the detached one is covered in
  // tests/agent-session-host.test.ts.
  process.env.AGENT_DETACHED_CONTAINERS = "0";
  process.env.AGENT_CONTAINER_RUNTIME = FAKE_DOCKER;
  process.env.FAKE_STEER_MODE = mode;
  process.env.AGENT_CONTAINER_OCI_RUNTIME = "runc";
  try {
    const run = new ContainerRunner().run(
      {
        mode: "conversation",
        documentTitle: "Test",
        documentText: "",
        unresolvedThreads: [],
        workspacePath: workspace,
        workspaceOverview: "",
        instruction: "hi"
      },
      { aiRunId: runId, agentConfig: { model: "claude-sonnet-5" }, agentEnv: { ANTHROPIC_API_KEY: "sk-ant-api03-test" } }
    );
    for (let i = 0; i < 200 && !isSteerableAiRun(runId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(isSteerableAiRun(runId), true, "the container run never registered a steering injector");
    const delivered = await injectRunMessage(runId, "a follow-up");
    await injectRunMessage(runId, "__finish__");
    await run;
    return delivered;
  } finally {
    process.env.AGENT_CONTAINER_RUNTIME = saved.runtime;
    process.env.FAKE_STEER_MODE = saved.mode;
    process.env.AGENT_CONTAINER_OCI_RUNTIME = saved.oci;
    process.env.AGENT_DETACHED_CONTAINERS = saved.detached;
    if (saved.detached === undefined) delete process.env.AGENT_DETACHED_CONTAINERS;
    if (saved.runtime === undefined) delete process.env.AGENT_CONTAINER_RUNTIME;
    if (saved.mode === undefined) delete process.env.FAKE_STEER_MODE;
    if (saved.oci === undefined) delete process.env.AGENT_CONTAINER_OCI_RUNTIME;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("a steering message the container accepted counts as delivered", async () => {
  assert.equal(await steerOnce("accept"), true);
});

test("a steering message the container refused is NOT reported as delivered", async () => {
  assert.equal(await steerOnce("refuse"), false, "the caller must fall back to the ⏳ queue");
});

test("a container that never acknowledges is treated as not delivered", { timeout: 30_000 }, async () => {
  assert.equal(await steerOnce("silent"), false);
});
