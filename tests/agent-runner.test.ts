import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAgentRunner,
  resolveAgentRunnerMode,
  toAgentJob,
  type AgentJob
} from "../lib/agent-runner";
import { InProcessRunner } from "../lib/agent-runner/inprocess";
import { HttpRunner } from "../lib/agent-runner/http";

test("resolveAgentRunnerMode defaults to inprocess and honors AGENT_RUNNER_MODE", () => {
  assert.equal(resolveAgentRunnerMode({}), "inprocess");
  assert.equal(resolveAgentRunnerMode({ AGENT_RUNNER_MODE: "inprocess" }), "inprocess");
  assert.equal(resolveAgentRunnerMode({ AGENT_RUNNER_MODE: "http" }), "http");
  assert.equal(resolveAgentRunnerMode({ AGENT_RUNNER_MODE: "HTTP" }), "http");
  assert.equal(resolveAgentRunnerMode({ AGENT_RUNNER_MODE: " http " }), "http");
  // Unknown values fall back to the safe (working) default rather than erroring.
  assert.equal(resolveAgentRunnerMode({ AGENT_RUNNER_MODE: "docker" }), "inprocess");
});

test("createAgentRunner returns the backend matching the mode", () => {
  const inproc = createAgentRunner("inprocess");
  assert.ok(inproc instanceof InProcessRunner);
  assert.equal(inproc.mode, "inprocess");

  const http = createAgentRunner("http");
  assert.ok(http instanceof HttpRunner);
  assert.equal(http.mode, "http");
});

test("HttpRunner fails loudly until implemented (never silently runs unsandboxed)", async () => {
  const http = createAgentRunner("http");
  await assert.rejects(
    () =>
      http.run({
        mode: "conversation",
        documentTitle: "t",
        documentText: "",
        unresolvedThreads: [],
        workspacePath: null,
        workspaceOverview: "",
        instruction: "hi"
      }),
    /not implemented yet/i
  );
});

test("toAgentJob splits serializable job data from runtime handlers and round-trips through JSON", () => {
  const input = {
    mode: "edit_selection" as const,
    documentTitle: "Doc",
    documentText: "body",
    documentBlocks: [{ type: "text" as const, text: "body" }],
    unresolvedThreads: [],
    workspacePath: "/work/.research-workspaces/doc-1/worktrees/run-1",
    workspaceOverview: "files...",
    selectedText: "old",
    selectedMarkdown: "old",
    selectedContext: "ctx",
    instruction: "rewrite"
  };
  const job = toAgentJob(input, {
    agentConfig: { model: "claude-opus-4-8", effort: "high" },
    agentEnv: { MY_DOC_SECRET: "s3cret" },
    // Handlers must NOT leak into the serializable job:
    onProgress: () => {},
    validateSubmission: async () => null
  });

  assert.deepEqual(job.agentConfig, { model: "claude-opus-4-8", effort: "high" });
  assert.deepEqual(job.agentEnv, { MY_DOC_SECRET: "s3cret" });
  assert.equal(job.input.instruction, "rewrite");
  assert.ok(!("onProgress" in job));
  assert.ok(!("validateSubmission" in job));

  const roundTripped = JSON.parse(JSON.stringify(job)) as AgentJob;
  assert.deepEqual(roundTripped, job);
});
