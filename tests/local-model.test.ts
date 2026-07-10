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
  freeLocalAgentModel,
  loadAgentEnvWithFreeFallback,
  normalizeCredentialInput,
  providerKeyRequirementError,
  upsertUserCredential
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
