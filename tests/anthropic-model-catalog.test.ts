import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import {
  agentModelOptionLabel,
  ANTHROPIC_LATEST_AGENT_MODELS,
  isStorableAgentModel,
  LITELLM_CLAUDE_AGENT_MODELS,
  resolveAgentSdkConfig,
  resolveLatestAnthropicAlias,
  resolveRefusalFallbackModel,
  REFUSAL_FALLBACK_MODEL
} from "../agent-core/agent-config";
import { hasNativeLongContext } from "../agent-core/agent-env";
import {
  anthropicCatalogCredentialFromEnv,
  getLatestAnthropicModels,
  MODEL_CATALOG_TTL_MS,
  pickLatestAnthropicModels,
  refreshLatestAnthropicModels,
  resetAnthropicModelCatalog
} from "../lib/anthropic-model-catalog";
import { db } from "../lib/db";
import {
  loadAgentEnvWithFreeFallback,
  normalizeCredentialInput,
  upsertUserCredential
} from "../lib/user-credentials";

process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.AGENT_REQUIRE_USER_CREDENTIAL = "1";
delete process.env.AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS;
delete process.env.CLAUDE_AGENT_MODEL;

// A Models API listing as it would look after a hypothetical Opus 6 launch.
const LISTING = [
  { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-08-01T00:00:00Z" },
  { id: "claude-opus-6", display_name: "Claude Opus 6", created_at: "2026-10-01T00:00:00Z" },
  { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", created_at: "2026-11-01T00:00:00Z" },
  { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-05-01T00:00:00Z" },
  { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-09-01T00:00:00Z" },
  { id: "claude-sonnet-4-5-20250929", display_name: "Claude Sonnet 4.5", created_at: "2027-01-01T00:00:00Z" },
  { id: "claude-fable-5-1", display_name: "Claude Fable 5.1", created_at: "2026-09-01T00:00:00Z" },
  { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", created_at: "2025-10-01T00:00:00Z" }
];

function fakeModelsApi(listing = LISTING) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify({ data: listing, has_more: false, last_id: null }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return { impl, calls };
}

const created = { users: [] as string[], documents: [] as string[] };

test.after(async () => {
  resetAnthropicModelCatalog();
  await db.document.deleteMany({ where: { id: { in: created.documents } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
  await db.$disconnect();
});

test("pickLatestAnthropicModels picks the highest version per family, ignoring dated snapshots and haiku", () => {
  assert.deepEqual(pickLatestAnthropicModels(LISTING), {
    opus: { id: "claude-opus-6", label: "Opus 6" },
    sonnet: { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    fable: { id: "claude-fable-5-1", label: "Fable 5.1" }
  });
  assert.deepEqual(pickLatestAnthropicModels([]), {});
});

test("resolveLatestAnthropicAlias maps bare and LiteLLM aliases, leaves everything else alone", () => {
  const latest = { opus: { id: "claude-opus-6", label: "Opus 6" } };
  assert.equal(resolveLatestAnthropicAlias("claude-opus-latest", latest), "claude-opus-6");
  assert.equal(
    resolveLatestAnthropicAlias("litellm/anthropic/claude-opus-latest", latest),
    "litellm/anthropic/claude-opus-6"
  );
  // Nothing discovered for the family → built-in fallback.
  assert.equal(resolveLatestAnthropicAlias("claude-sonnet-latest", latest), "claude-sonnet-5-5");
  assert.equal(resolveLatestAnthropicAlias("claude-opus-5-5", latest), "claude-opus-5-5");
  assert.equal(resolveLatestAnthropicAlias("openrouter/openai/gpt-6-astra", latest), "openrouter/openai/gpt-6-astra");
  assert.equal(resolveLatestAnthropicAlias("constructor", latest), "constructor");
});

test("aliases and newer discovered ids are storable and run in agent-core", () => {
  for (const value of ["claude-opus-latest", "claude-sonnet-latest", "claude-fable-latest", "claude-opus-6"]) {
    assert.equal(isStorableAgentModel(value), true, value);
  }
  // An alias that reaches agent-core unresolved runs the built-in fallback.
  assert.equal(resolveAgentSdkConfig({ model: "claude-opus-latest" }).model, "claude-opus-5-5");
  // A model newer than this codebase is run as-is, not swapped for the default.
  const future = resolveAgentSdkConfig({ model: "claude-opus-6", effort: "high" });
  assert.equal(future.model, "claude-opus-6");
  assert.equal(future.label, "claude-agent-sdk:claude-opus-6+high");
});

test("future models keep the native 1M window and the Fable refusal fallback", () => {
  assert.equal(hasNativeLongContext("claude-opus-6"), true);
  assert.equal(hasNativeLongContext("claude-sonnet-5-5"), true);
  assert.equal(hasNativeLongContext("claude-fable-6-2[1m]"), true);
  assert.equal(hasNativeLongContext("claude-opus-4-6"), false);
  assert.equal(hasNativeLongContext("claude-haiku-5"), false);
  assert.equal(resolveRefusalFallbackModel({ model: "claude-fable-latest" }), REFUSAL_FALLBACK_MODEL);
  assert.equal(resolveRefusalFallbackModel({ model: "claude-fable-6" }), REFUSAL_FALLBACK_MODEL);
  assert.equal(resolveRefusalFallbackModel({ model: "claude-opus-latest" }), null);
});

test("picker labels spell out what latest means", () => {
  const opus = ANTHROPIC_LATEST_AGENT_MODELS.find((m) => m.value === "claude-opus-latest")!;
  assert.equal(agentModelOptionLabel(opus), "Opus latest (Opus 5.5)");
  assert.equal(agentModelOptionLabel(opus, { "claude-opus-latest": "Opus 6" }), "Opus latest (Opus 6)");
  const viaLiteLlm = LITELLM_CLAUDE_AGENT_MODELS.find((m) => m.value === "litellm/anthropic/claude-opus-latest")!;
  assert.equal(
    agentModelOptionLabel(viaLiteLlm, { "claude-opus-latest": "Opus 6" }),
    "Opus latest (Opus 6, via LiteLLM)"
  );
});

test("the catalog refreshes with the given credential (OAuth headers), caches, and degrades quietly", async () => {
  resetAnthropicModelCatalog();
  const api = fakeModelsApi();
  const now = Date.parse("2026-10-08T12:00:00Z");

  // No credential → nothing is fetched.
  assert.deepEqual(await refreshLatestAnthropicModels(null, { now, fetchImpl: api.impl }), {});
  assert.equal(api.calls.length, 0);

  const latest = await refreshLatestAnthropicModels(
    { kind: "oauth", value: "sk-ant-oat-test" },
    { now, fetchImpl: api.impl }
  );
  assert.equal(latest.opus?.id, "claude-opus-6");
  assert.equal(api.calls.length, 1);
  assert.match(api.calls[0].url, /^https:\/\/api\.anthropic\.com\/v1\/models\?/);
  assert.equal(api.calls[0].headers.authorization, "Bearer sk-ant-oat-test");
  assert.equal(api.calls[0].headers["anthropic-beta"], "oauth-2025-04-20");

  // Fresh cache → no second request.
  await refreshLatestAnthropicModels({ kind: "api_key", value: "sk-ant-api" }, { now: now + 1000, fetchImpl: api.impl });
  assert.equal(api.calls.length, 1);

  // Stale + failing API → previous answer stays.
  const failing = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  const stale = await refreshLatestAnthropicModels(
    { kind: "api_key", value: "sk-ant-api" },
    { now: now + MODEL_CATALOG_TTL_MS + 1, fetchImpl: failing }
  );
  assert.equal(stale.opus?.id, "claude-opus-6");
});

test("a credential behind a custom base URL is never sent to api.anthropic.com", () => {
  assert.equal(
    anthropicCatalogCredentialFromEnv({ ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_BASE_URL: "https://proxy" }),
    null
  );
  assert.deepEqual(anthropicCatalogCredentialFromEnv({ ANTHROPIC_API_KEY: "sk-ant-x" }), {
    kind: "api_key",
    value: "sk-ant-x"
  });
  assert.deepEqual(anthropicCatalogCredentialFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-y" }), {
    kind: "oauth",
    value: "sk-ant-oat-y"
  });
});

test("run start pins a latest alias (and the default) to the newest model, discovered with the run's own credential", async () => {
  resetAnthropicModelCatalog();
  const api = fakeModelsApi();
  const realFetch = globalThis.fetch;
  globalThis.fetch = api.impl;
  try {
    const owner = await db.user.create({
      data: { email: `latest-model-${crypto.randomUUID()}@example.com`, name: "latest", passwordHash: "x" }
    });
    created.users.push(owner.id);
    await upsertUserCredential(owner.id, normalizeCredentialInput({ value: "sk-ant-api03-owner-key" }));
    const doc = await db.document.create({
      data: { title: "latest model", content: JSON.stringify({ type: "doc", content: [] }), ownerId: owner.id }
    });
    created.documents.push(doc.id);

    const opus = await loadAgentEnvWithFreeFallback(doc.id, { model: "claude-opus-latest", effort: "high" }, owner.id);
    assert.equal(opus.agentConfig.model, "claude-opus-6");
    assert.equal(opus.agentConfig.effort, "high");
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].headers["x-api-key"], "sk-ant-api03-owner-key");
    assert.equal(getLatestAnthropicModels().sonnet?.id, "claude-sonnet-5-5");

    // No explicit model → the default alias → newest Sonnet.
    const fallback = await loadAgentEnvWithFreeFallback(doc.id, { model: null, effort: null }, owner.id);
    assert.equal(fallback.agentConfig.model, "claude-sonnet-5-5");

    // Pinned versions are untouched.
    const pinned = await loadAgentEnvWithFreeFallback(doc.id, { model: "claude-opus-5-5", effort: null }, owner.id);
    assert.equal(pinned.agentConfig.model, "claude-opus-5-5");
    assert.equal(api.calls.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
