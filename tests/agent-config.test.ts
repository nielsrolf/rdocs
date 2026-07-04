import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_AGENT_MAX_TURNS,
  DEFAULT_AGENT_MODEL,
  isAgentEffort,
  isAgentModel,
  isOpenRouterAgentModel,
  isStorableAgentModel,
  normalizeAgentModel,
  parseMaxTurns,
  resolveAgentSdkConfig,
  resolveRefusalFallbackModel,
  REFUSAL_FALLBACK_MODEL
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

test("defaults to the built-in model with thinking disabled when unconfigured", () => {
  const resolved = resolveAgentSdkConfig(null);
  assert.equal(resolved.model, DEFAULT_AGENT_MODEL);
  assert.equal(resolved.provider, "anthropic");
  assert.deepEqual(resolved.thinking, { type: "disabled" });
  assert.equal(resolved.effort, undefined);
  assert.equal(resolved.label, `claude-agent-sdk:${DEFAULT_AGENT_MODEL}`);
});

test("uses the env fallback model when the document has no explicit model", () => {
  const resolved = resolveAgentSdkConfig({ effort: "off" }, "claude-opus-4-8");
  assert.equal(resolved.model, "claude-opus-4-8");
  assert.deepEqual(resolved.thinking, { type: "disabled" });
});

test("legacy alias values (documents and env fallback) normalize to canonical ids", () => {
  assert.equal(normalizeAgentModel("sonnet"), "claude-sonnet-5");
  assert.equal(normalizeAgentModel("opus"), "claude-opus-4-8");
  assert.equal(normalizeAgentModel("claude-fable-5"), "claude-fable-5");

  const fromDocument = resolveAgentSdkConfig({ model: "opus", effort: "high" });
  assert.equal(fromDocument.model, "claude-opus-4-8");
  assert.equal(fromDocument.label, "claude-agent-sdk:claude-opus-4-8+high");

  const fromEnvFallback = resolveAgentSdkConfig(null, "sonnet");
  assert.equal(fromEnvFallback.model, "claude-sonnet-5");
});

test("an explicit document model overrides the env fallback", () => {
  const resolved = resolveAgentSdkConfig({ model: "claude-opus-4-8", effort: null }, "claude-sonnet-5");
  assert.equal(resolved.model, "claude-opus-4-8");
});

test("an unrecognised model falls back instead of being passed through", () => {
  const resolved = resolveAgentSdkConfig({ model: "gpt-5" }, "claude-sonnet-5");
  assert.equal(resolved.model, "claude-sonnet-5");
});

test("enables adaptive thinking with the chosen effort level", () => {
  for (const effort of ["low", "medium", "high"] as const) {
    const resolved = resolveAgentSdkConfig({ model: "claude-opus-4-8", effort });
    assert.deepEqual(resolved.thinking, { type: "adaptive" });
    assert.equal(resolved.effort, effort);
    assert.equal(resolved.label, `claude-agent-sdk:claude-opus-4-8+${effort}`);
  }
});

test("an invalid or off effort disables extended thinking", () => {
  for (const effort of ["off", "bogus", "", null, undefined]) {
    const resolved = resolveAgentSdkConfig({ model: "claude-sonnet-5", effort: effort as string });
    assert.deepEqual(resolved.thinking, { type: "disabled" });
    assert.equal(resolved.effort, undefined);
  }
});

test("openrouter models resolve to the bare slug with thinking force-disabled", () => {
  const resolved = resolveAgentSdkConfig({ model: "openrouter/openai/gpt-5.2", effort: "high" });
  assert.equal(resolved.provider, "openrouter");
  assert.equal(resolved.model, "openai/gpt-5.2");
  // Anthropic-specific adaptive-thinking params must never reach the compat
  // endpoint for non-Claude models, even when the document configured effort.
  assert.deepEqual(resolved.thinking, { type: "disabled" });
  assert.equal(resolved.effort, undefined);
  assert.equal(resolved.label, "openrouter:openai/gpt-5.2");
});

test("an openrouter env fallback routes through the openrouter provider too", () => {
  const resolved = resolveAgentSdkConfig(null, "openrouter/deepseek/deepseek-v3.2");
  assert.equal(resolved.provider, "openrouter");
  assert.equal(resolved.model, "deepseek/deepseek-v3.2");
});

test("isStorableAgentModel accepts known models, legacy aliases, and well-formed openrouter slugs", () => {
  for (const value of [
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "sonnet",
    "opus",
    "openrouter/openai/gpt-5.2",
    "openrouter/moonshotai/kimi-k2",
    "openrouter/deepseek/deepseek-v3.2:free",
    "openrouter/x-ai/grok-4"
  ]) {
    assert.equal(isStorableAgentModel(value), true, `expected storable: ${value}`);
  }
});

test("isStorableAgentModel rejects malformed or dangerous values", () => {
  for (const value of [
    "gpt-5",
    "claude-sonnet-4-6",
    "openrouter/",
    "openrouter/noslash",
    "openrouter//leading",
    "openrouter/a b/c",
    "openrouter/../../etc/passwd",
    "openrouter/openai/gpt-5.2/extra",
    `openrouter/${"a".repeat(160)}/b`,
    "",
    null,
    42
  ]) {
    assert.equal(isStorableAgentModel(value), false, `expected rejected: ${String(value)}`);
  }
});

test("isOpenRouterAgentModel distinguishes providers including legacy aliases", () => {
  assert.equal(isOpenRouterAgentModel("openrouter/openai/gpt-5.2"), true);
  assert.equal(isOpenRouterAgentModel("claude-sonnet-5"), false);
  assert.equal(isOpenRouterAgentModel("sonnet"), false);
  assert.equal(isOpenRouterAgentModel(null), false);
});

test("type guards accept known values and reject unknown ones", () => {
  assert.equal(isAgentModel("sonnet"), true);
  assert.equal(isAgentModel("opus"), true);
  assert.equal(isAgentModel("claude-fable-5"), true);
  assert.equal(isAgentModel("openrouter/openai/gpt-5.2"), true);
  assert.equal(isAgentModel("gpt-5"), false);
  assert.equal(isAgentModel(null), false);
  assert.equal(isAgentEffort("high"), true);
  assert.equal(isAgentEffort("off"), true);
  assert.equal(isAgentEffort("ultra"), false);
});

test("resolveRefusalFallbackModel maps a fable run to opus and nothing else", () => {
  // The one case that should fall back: a Fable run refused by the safety
  // classifiers reruns on Opus 4.8.
  assert.equal(
    resolveRefusalFallbackModel({ model: "claude-fable-5", effort: "high" }),
    REFUSAL_FALLBACK_MODEL
  );
  assert.equal(REFUSAL_FALLBACK_MODEL, "claude-opus-4-8");

  // Already on the fallback model (or another Anthropic model): no fallback.
  assert.equal(resolveRefusalFallbackModel({ model: "claude-opus-4-8" }), null);
  assert.equal(resolveRefusalFallbackModel({ model: "claude-sonnet-5" }), null);
  assert.equal(resolveRefusalFallbackModel(null), null);

  // Non-Anthropic providers never fall back to an Anthropic model.
  assert.equal(resolveRefusalFallbackModel({ model: "openrouter/openai/gpt-5.5" }), null);
});

test("resolveRefusalFallbackModel honors the env fallback model like resolveAgentSdkConfig", () => {
  // Document has no explicit model; the env default decides what actually ran.
  assert.equal(resolveRefusalFallbackModel(null, "claude-fable-5"), REFUSAL_FALLBACK_MODEL);
  assert.equal(resolveRefusalFallbackModel({ effort: "off" }, "claude-fable-5"), REFUSAL_FALLBACK_MODEL);
  assert.equal(resolveRefusalFallbackModel(null, "claude-sonnet-5"), null);
});
