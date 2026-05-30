import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_AGENT_MAX_TURNS,
  DEFAULT_AGENT_MODEL,
  isAgentEffort,
  isAgentModel,
  parseMaxTurns,
  resolveAgentSdkConfig
} from "../lib/agent-config";

test("parseMaxTurns defaults to an effectively-unbounded budget (never the old low cap)", () => {
  // Regression: the merge-conflict resolver used to cap at 8 turns and die with
  // "Max turns reached (8)" mid-resolution.
  assert.equal(parseMaxTurns(undefined), DEFAULT_AGENT_MAX_TURNS);
  assert.equal(parseMaxTurns(null), DEFAULT_AGENT_MAX_TURNS);
  assert.equal(parseMaxTurns(""), DEFAULT_AGENT_MAX_TURNS);
  assert.ok(DEFAULT_AGENT_MAX_TURNS >= 1_000_000, "default must be effectively unbounded");
});

test("parseMaxTurns honors a valid positive env override and ignores junk", () => {
  assert.equal(parseMaxTurns("25"), 25);
  assert.equal(parseMaxTurns("garbage"), DEFAULT_AGENT_MAX_TURNS);
  assert.equal(parseMaxTurns("0"), DEFAULT_AGENT_MAX_TURNS);
  assert.equal(parseMaxTurns("-3"), DEFAULT_AGENT_MAX_TURNS);
});

test("defaults to the fallback model with thinking disabled when unconfigured", () => {
  const resolved = resolveAgentSdkConfig(null);
  assert.equal(resolved.model, DEFAULT_AGENT_MODEL);
  assert.deepEqual(resolved.thinking, { type: "disabled" });
  assert.equal(resolved.effort, undefined);
  // Preserves the historical AiRun.model label the comments suite asserts on.
  assert.equal(resolved.label, "claude-agent-sdk:sonnet");
});

test("uses the env fallback model when the document has no explicit model", () => {
  const resolved = resolveAgentSdkConfig({ effort: "off" }, "opus");
  assert.equal(resolved.model, "opus");
  assert.deepEqual(resolved.thinking, { type: "disabled" });
});

test("an explicit document model overrides the env fallback", () => {
  const resolved = resolveAgentSdkConfig({ model: "opus", effort: null }, "sonnet");
  assert.equal(resolved.model, "opus");
});

test("an unrecognised model falls back instead of being passed through", () => {
  const resolved = resolveAgentSdkConfig({ model: "gpt-5" }, "sonnet");
  assert.equal(resolved.model, "sonnet");
});

test("enables adaptive thinking with the chosen effort level", () => {
  for (const effort of ["low", "medium", "high"] as const) {
    const resolved = resolveAgentSdkConfig({ model: "opus", effort });
    assert.deepEqual(resolved.thinking, { type: "adaptive" });
    assert.equal(resolved.effort, effort);
    assert.equal(resolved.label, `claude-agent-sdk:opus+${effort}`);
  }
});

test("an invalid or off effort disables extended thinking", () => {
  for (const effort of ["off", "bogus", "", null, undefined]) {
    const resolved = resolveAgentSdkConfig({ model: "sonnet", effort: effort as string });
    assert.deepEqual(resolved.thinking, { type: "disabled" });
    assert.equal(resolved.effort, undefined);
  }
});

test("type guards accept known values and reject unknown ones", () => {
  assert.equal(isAgentModel("sonnet"), true);
  assert.equal(isAgentModel("opus"), true);
  assert.equal(isAgentModel("gpt-5"), false);
  assert.equal(isAgentModel(null), false);
  assert.equal(isAgentEffort("high"), true);
  assert.equal(isAgentEffort("off"), true);
  assert.equal(isAgentEffort("ultra"), false);
});
