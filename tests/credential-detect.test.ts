import assert from "node:assert/strict";
import { test } from "node:test";

import { detectCredential, looksLikeMcpToken } from "../lib/credential-detect";
import { normalizeCredentialInput } from "../lib/user-credentials";

test("detectCredential recognizes every prefixed provider", () => {
  assert.deepEqual(detectCredential("sk-ant-oat01-abc"), {
    provider: "anthropic",
    kind: "oauth",
    label: "Claude subscription token"
  });
  assert.equal(detectCredential("sk-ant-api03-xyz")?.provider, "anthropic");
  assert.equal(detectCredential("sk-ant-api03-xyz")?.kind, "api_key");
  assert.equal(detectCredential("sk-or-v1-abcdef")?.provider, "openrouter");
  assert.equal(detectCredential("ghp_abc123")?.provider, "github");
  assert.equal(detectCredential("github_pat_11AAA")?.provider, "github");
  assert.equal(detectCredential("gho_xyz")?.provider, "github");
  assert.equal(detectCredential("  sk-ant-padded  ")?.provider, "anthropic");
});

test("detectCredential returns null for opaque values (LiteLLM keys)", () => {
  assert.equal(detectCredential("sk-1234567890"), null);
  assert.equal(detectCredential("my-litellm-proxy-key"), null);
  assert.equal(detectCredential(""), null);
});

test("looksLikeMcpToken flags our own bearer tokens", () => {
  assert.equal(looksLikeMcpToken("gdai_abc123"), true);
  assert.equal(looksLikeMcpToken("sk-ant-abc"), false);
});

test("normalizeCredentialInput without a provider auto-detects from the format", () => {
  assert.deepEqual(normalizeCredentialInput({ value: "sk-or-v1-abc" }), {
    provider: "openrouter",
    kind: "api_key",
    value: "sk-or-v1-abc"
  });
  assert.deepEqual(normalizeCredentialInput({ value: "github_pat_11AAA" }), {
    provider: "github",
    kind: "api_key",
    value: "github_pat_11AAA"
  });
  assert.deepEqual(normalizeCredentialInput({ value: "sk-ant-oat01-x" }), {
    provider: "anthropic",
    kind: "oauth",
    value: "sk-ant-oat01-x"
  });
});

test("normalizeCredentialInput rejects unrecognizable values without a provider", () => {
  assert.throws(() => normalizeCredentialInput({ value: "opaque-key" }), /Specify the provider/);
  // …but accepts them with an explicit provider (the LiteLLM path).
  assert.deepEqual(normalizeCredentialInput({ provider: "litellm", value: "opaque-key" }), {
    provider: "litellm",
    kind: "api_key",
    value: "opaque-key"
  });
});

test("normalizeCredentialInput rejects gdai_ MCP tokens outright", () => {
  assert.throws(() => normalizeCredentialInput({ value: "gdai_abc" }), /MCP token/);
  assert.throws(() => normalizeCredentialInput({ provider: "litellm", value: "gdai_abc" }), /MCP token/);
});
