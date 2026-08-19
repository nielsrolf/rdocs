import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import {
  agentModelProvider,
  isStorableAgentModel,
  resolveAgentSdkConfig
} from "../agent-core/agent-config";
import { applyProviderEnv } from "../agent-core/agent-env";
import { db } from "../lib/db";
import {
  anthropicRunUsesFreeFallback,
  credentialRequirementFailure,
  freeLocalAgentModel,
  isAgentCredentialError,
  loadAgentEnvWithFreeFallback,
  normalizeCredentialInput,
  providerKeyRequirementError,
  providerKeyRequirementFailure,
  upsertUserCredential,
  type AgentCredentialError
} from "../lib/user-credentials";

process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
// Strict mode + no host GitHub token: the fallback must fire from the
// credential miss alone, not from ambient host credentials.
process.env.AGENT_REQUIRE_USER_CREDENTIAL = "1";
delete process.env.AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS;
delete process.env.GITHUB_TOKEN;
process.env.LOCAL_MODEL_BASE_URL = "http://100.96.238.46:8080";
process.env.LOCAL_MODEL_NAME = "qwen3.6-27b";

const created = { users: [] as string[], documents: [] as string[] };

async function makeUser(prefix: string) {
  const user = await db.user.create({
    data: { email: `${prefix}-${crypto.randomUUID()}@example.com`, name: prefix, passwordHash: "x" }
  });
  created.users.push(user.id);
  return user;
}

async function makeDoc(ownerId: string) {
  const doc = await db.document.create({
    data: { title: "local model test", content: JSON.stringify({ type: "doc", content: [] }), ownerId }
  });
  created.documents.push(doc.id);
  return doc;
}

test.after(async () => {
  await db.document.deleteMany({ where: { id: { in: created.documents } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
  await db.$disconnect();
});

test("local/<name> routes, validates, and resolves as the local provider", () => {
  assert.equal(agentModelProvider("local/qwen3.6-27b"), "local");
  assert.equal(isStorableAgentModel("local/qwen3.6-27b"), true);
  assert.equal(isStorableAgentModel("local/../etc"), false);

  const resolved = resolveAgentSdkConfig({ model: "local/qwen3.6-27b", effort: "high" });
  assert.equal(resolved.model, "qwen3.6-27b");
  assert.equal(resolved.provider, "local");
  assert.equal(resolved.label, "local:qwen3.6-27b");
  // Extended thinking is Anthropic-specific — always disabled for local.
  assert.deepEqual(resolved.thinking, { type: "disabled" });
});

test("applyProviderEnv points the SDK at the llama.cpp server without credentials", () => {
  const env = applyProviderEnv(
    {
      LOCAL_MODEL_BASE_URL: "http://100.96.238.46:8080/",
      ANTHROPIC_API_KEY: "sk-ant-host",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-host"
    },
    "local"
  );
  assert.equal(env.ANTHROPIC_BASE_URL, "http://100.96.238.46:8080");
  assert.ok(env.ANTHROPIC_AUTH_TOKEN);
  // No Anthropic credential may survive into a local-model run.
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in env, false);

  assert.throws(() => applyProviderEnv({}, "local"), /LOCAL_MODEL_BASE_URL/);
});

test("providerKeyRequirementError for local needs only the base URL", () => {
  assert.equal(providerKeyRequirementError({}, "local/qwen3.6-27b", { LOCAL_MODEL_BASE_URL: "http://x" }), null);
  assert.match(
    providerKeyRequirementError({}, "local/qwen3.6-27b", {}) ?? "",
    /LOCAL_MODEL_BASE_URL/
  );
});

test("freeLocalAgentModel requires both name and base URL", () => {
  assert.equal(freeLocalAgentModel({ LOCAL_MODEL_NAME: "q", LOCAL_MODEL_BASE_URL: "http://x" }), "local/q");
  assert.equal(freeLocalAgentModel({ LOCAL_MODEL_NAME: "q" }), null);
  assert.equal(freeLocalAgentModel({}), null);
});

test("credential-less Anthropic run falls back to the free local model", async () => {
  const owner = await makeUser("local-fallback");
  const doc = await makeDoc(owner.id);

  const result = await loadAgentEnvWithFreeFallback(
    doc.id,
    { model: "claude-sonnet-5", effort: "high" },
    owner.id
  );
  assert.equal(result.usedFreeFallback, true);
  assert.equal(result.agentConfig.model, "local/qwen3.6-27b");
  assert.equal(result.agentConfig.effort, "high");
});

test("a connected credential wins over the free fallback", async () => {
  const owner = await makeUser("local-cred");
  await upsertUserCredential(
    owner.id,
    normalizeCredentialInput({ provider: "anthropic", value: "sk-ant-owner-key" })
  );
  const doc = await makeDoc(owner.id);

  const result = await loadAgentEnvWithFreeFallback(
    doc.id,
    { model: "claude-sonnet-5", effort: null },
    owner.id
  );
  assert.equal(result.usedFreeFallback, false);
  assert.equal(result.agentConfig.model, "claude-sonnet-5");
  assert.equal(result.agentEnv.ANTHROPIC_API_KEY, "sk-ant-owner-key");
});

test("without a configured local model the credential miss still throws", async () => {
  const owner = await makeUser("local-none");
  const doc = await makeDoc(owner.id);
  const savedBase = process.env.LOCAL_MODEL_BASE_URL;
  delete process.env.LOCAL_MODEL_BASE_URL;
  try {
    await assert.rejects(
      () => loadAgentEnvWithFreeFallback(doc.id, { model: "claude-sonnet-5", effort: null }, owner.id),
      /Connect an Anthropic credential/
    );
  } finally {
    process.env.LOCAL_MODEL_BASE_URL = savedBase;
  }
});

test("provider-key misses do NOT fall back (only the Anthropic credential miss does)", async () => {
  const owner = await makeUser("local-orkey");
  const doc = await makeDoc(owner.id);
  await assert.rejects(
    () =>
      loadAgentEnvWithFreeFallback(doc.id, { model: "openrouter/openai/gpt-5.2", effort: null }, owner.id),
    /OPENROUTER_API_KEY/
  );
});

test("native Codex selection falls back to the matching LiteLLM Responses model when that is the available credential", async () => {
  const owner = await makeUser("codex-litellm-fallback");
  await upsertUserCredential(
    owner.id,
    normalizeCredentialInput({ provider: "litellm", value: "sk-litellm-owner" })
  );
  const doc = await makeDoc(owner.id);

  const result = await loadAgentEnvWithFreeFallback(
    doc.id,
    { model: "codex/openai/gpt-5.6-terra", effort: "medium" },
    owner.id
  );
  assert.equal(result.usedFreeFallback, false);
  assert.equal(result.usedProviderFallback, true);
  assert.equal(result.agentConfig.model, "codex/litellm/openai/gpt-5.6-terra");
  assert.equal(result.agentEnv.LITELLM_API_KEY, "sk-litellm-owner");
});

test("native Codex selection still fails clearly when neither OpenAI nor LiteLLM is connected", async () => {
  const owner = await makeUser("codex-no-provider");
  const doc = await makeDoc(owner.id);
  await assert.rejects(
    () => loadAgentEnvWithFreeFallback(
      doc.id,
      { model: "codex/openai/gpt-5.6-terra", effort: null },
      owner.id
    ),
    /OPENAI_API_KEY/
  );
});

// The fallback branches used to classify failures by matching the user-facing
// message ("=== CONNECT_CREDENTIAL_MESSAGE", ".includes('OPENAI_API_KEY')").
// The contract is now the typed code/provider pair, so rewording a message
// cannot silently disable a fallback and an unrelated error that merely
// mentions a key name cannot hijack one.
test("credential misses throw a typed AgentCredentialError, not a message to match on", async () => {
  const owner = await makeUser("typed-credential-error");
  const doc = await makeDoc(owner.id);

  const anthropicMiss = await loadAgentEnvWithFreeFallback(
    doc.id,
    { model: "claude-sonnet-5", effort: null },
    owner.id
  ).then(
    () => null,
    (error) => error
  );
  // With a local model configured this one falls back rather than throwing.
  assert.equal(anthropicMiss, null);

  const codexMiss = await loadAgentEnvWithFreeFallback(
    doc.id,
    { model: "codex/openai/gpt-5.6-terra", effort: null },
    owner.id
  ).then(
    () => null,
    (error) => error
  );
  assert.ok(isAgentCredentialError(codexMiss, "provider-key-missing"));
  assert.equal((codexMiss as AgentCredentialError).provider, "openai");
  assert.equal((codexMiss as AgentCredentialError).envKey, "OPENAI_API_KEY");

  // A lookalike: same words, not a credential failure.
  assert.equal(isAgentCredentialError(new Error("OPENAI_API_KEY rotation failed")), false);
});

test("requirement failures carry codes matching their messages", () => {
  assert.equal(credentialRequirementFailure({}, "claude-sonnet-5")?.code, "anthropic-credential-missing");
  assert.equal(credentialRequirementFailure({ ANTHROPIC_API_KEY: "sk-ant-x" }, "claude-sonnet-5"), null);
  const openrouter = providerKeyRequirementFailure({}, "openrouter/openai/gpt-5.2");
  assert.equal(openrouter?.code, "provider-key-missing");
  assert.equal(openrouter?.provider, "openrouter");
  assert.equal(openrouter?.envKey, "OPENROUTER_API_KEY");
  assert.equal(openrouter?.message, providerKeyRequirementError({}, "openrouter/openai/gpt-5.2"));
});

test("anthropicRunUsesFreeFallback: true without a credential, false once one is connected", async () => {
  const owner = await makeUser("fallback-predicate");
  const doc = await makeDoc(owner.id);

  assert.equal(await anthropicRunUsesFreeFallback(doc.id, owner.id), true);

  await upsertUserCredential(
    owner.id,
    normalizeCredentialInput({ value: "sk-ant-api03-predicate-test" })
  );
  assert.equal(await anthropicRunUsesFreeFallback(doc.id, owner.id), false);
});

test("anthropicRunUsesFreeFallback: false when no local model is configured", async () => {
  const owner = await makeUser("fallback-predicate-nolocal");
  const doc = await makeDoc(owner.id);
  const base = process.env.LOCAL_MODEL_BASE_URL;
  delete process.env.LOCAL_MODEL_BASE_URL;
  try {
    assert.equal(await anthropicRunUsesFreeFallback(doc.id, owner.id), false);
  } finally {
    process.env.LOCAL_MODEL_BASE_URL = base;
  }
});
