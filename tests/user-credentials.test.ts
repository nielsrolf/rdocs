import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import {
  applyOwnerCredentialEnv,
  applyToolCredentialEnv,
  credentialRequirementError,
  decryptSecret,
  detectCredentialKind,
  encryptSecret,
  normalizeCredentialInput,
  providerKeyRequirementError
} from "../lib/user-credentials";

// A valid 32-byte key for the encryption round-trip tests. getEncryptionKey()
// reads it lazily at call time, so setting it at module load (before any test
// runs) is sufficient — no dynamic import needed.
process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

// --- kind detection + validation -----------------------------------------

test("detectCredentialKind distinguishes oauth tokens from api keys", () => {
  assert.equal(detectCredentialKind("sk-ant-oat01-abc"), "oauth");
  assert.equal(detectCredentialKind("sk-ant-api03-xyz"), "api_key");
  assert.equal(detectCredentialKind("sk-ant-abc"), "api_key");
  assert.equal(detectCredentialKind("not-a-key"), null);
});

test("normalizeCredentialInput auto-detects kind and rejects mismatches", () => {
  assert.deepEqual(normalizeCredentialInput({ value: "sk-ant-api03-xyz" }), {
    provider: "anthropic",
    kind: "api_key",
    value: "sk-ant-api03-xyz"
  });
  assert.deepEqual(normalizeCredentialInput({ value: "sk-ant-oat01-abc" }), {
    provider: "anthropic",
    kind: "oauth",
    value: "sk-ant-oat01-abc"
  });
  // Explicit kind that agrees is accepted.
  assert.deepEqual(normalizeCredentialInput({ kind: "oauth", value: "sk-ant-oat01-abc" }), {
    provider: "anthropic",
    kind: "oauth",
    value: "sk-ant-oat01-abc"
  });
  // Explicit kind that disagrees is rejected.
  assert.throws(() => normalizeCredentialInput({ kind: "api_key", value: "sk-ant-oat01-abc" }), /looks like/i);
  // Unrecognized format without an explicit provider → asks for the provider
  // (single-field detect mode; only LiteLLM keys are legitimately opaque).
  assert.throws(() => normalizeCredentialInput({ value: "garbage" }), /specify the provider/i);
  // Anthropic asked for explicitly still demands an Anthropic-looking value.
  assert.throws(
    () => normalizeCredentialInput({ provider: "anthropic", value: "garbage" }),
    /Anthropic API key/i
  );
  // Empty rejected.
  assert.throws(() => normalizeCredentialInput({ value: "   " }), /required/i);
});

test("normalizeCredentialInput handles third-party provider keys", () => {
  assert.deepEqual(normalizeCredentialInput({ provider: "openrouter", value: " sk-or-v1-abc " }), {
    provider: "openrouter",
    kind: "api_key",
    value: "sk-or-v1-abc"
  });
  assert.deepEqual(normalizeCredentialInput({ provider: "litellm", value: "sk-7FW0abc" }), {
    provider: "litellm",
    kind: "api_key",
    value: "sk-7FW0abc"
  });
  // An Anthropic-looking value under a third-party provider is a mix-up.
  assert.throws(
    () => normalizeCredentialInput({ provider: "openrouter", value: "sk-ant-api03-xyz" }),
    /looks like an Anthropic credential/i
  );
  // Whitespace inside a key is never valid.
  assert.throws(() => normalizeCredentialInput({ provider: "litellm", value: "sk abc" }), /whitespace/i);
  assert.throws(() => normalizeCredentialInput({ provider: "litellm", value: "  " }), /required/i);
});

// --- encryption round-trip + missing key -----------------------------------

test("encryptSecret/decryptSecret round-trips and produces distinct ciphertexts", () => {
  const plaintext = "sk-ant-oat01-super-secret-token";
  const a = encryptSecret(plaintext);
  const b = encryptSecret(plaintext);
  assert.notEqual(a, b, "random IV should make ciphertexts differ");
  assert.ok(!a.includes("super-secret"), "ciphertext must not contain the plaintext");
  assert.equal(decryptSecret(a), plaintext);
  assert.equal(decryptSecret(b), plaintext);
});

test("decrypt fails on a tampered ciphertext (GCM auth tag)", () => {
  const enc = encryptSecret("sk-ant-api03-abc");
  const [iv, tag, data] = enc.split(":");
  const flipped = data.slice(0, -2) + (data.endsWith("A") ? "B" : "A") + data.slice(-1);
  assert.throws(() => decryptSecret(`${iv}:${tag}:${flipped}`));
});

test("encryption fails loudly when CREDENTIAL_ENCRYPTION_KEY is missing", () => {
  const saved = process.env.CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  try {
    assert.throws(() => encryptSecret("sk-ant-api03-abc"), /CREDENTIAL_ENCRYPTION_KEY is not set/);
  } finally {
    process.env.CREDENTIAL_ENCRYPTION_KEY = saved;
  }
});

test("encryption fails loudly on a wrong-length key", () => {
  const saved = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
  try {
    assert.throws(() => encryptSecret("sk-ant-api03-abc"), /32 bytes/);
  } finally {
    process.env.CREDENTIAL_ENCRYPTION_KEY = saved;
  }
});

// --- resolution precedence -------------------------------------------------

test("resolution precedence: document env credential wins over owner credential", () => {
  const env = applyOwnerCredentialEnv(
    { ANTHROPIC_API_KEY: "sk-ant-doc-key" },
    { kind: "oauth", value: "sk-ant-oat01-owner" },
    "claude-sonnet-5"
  );
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-doc-key");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("resolution precedence: owner credential fills in when doc env has none", () => {
  const env = applyOwnerCredentialEnv({}, { kind: "api_key", value: "sk-ant-owner" }, "claude-sonnet-5");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-owner");
});

test("resolution precedence: no owner credential leaves env untouched for requirement handling", () => {
  const env = applyOwnerCredentialEnv({ FOO: "bar" }, null, "claude-sonnet-5");
  assert.deepEqual(env, { FOO: "bar" });
});

// --- single-var injection --------------------------------------------------

test("single-var injection: api_key sets ANTHROPIC_API_KEY and drops any oauth token", () => {
  const env = applyOwnerCredentialEnv(
    { CLAUDE_CODE_OAUTH_TOKEN: "" },
    { kind: "api_key", value: "sk-ant-owner-key" },
    "claude-sonnet-5"
  );
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-owner-key");
  assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in env), "no stray oauth token");
});

test("single-var injection: oauth sets CLAUDE_CODE_OAUTH_TOKEN and drops any ANTHROPIC_API_KEY", () => {
  const env = applyOwnerCredentialEnv(
    { ANTHROPIC_API_KEY: "" },
    { kind: "oauth", value: "sk-ant-oat01-owner" },
    "claude-sonnet-5"
  );
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-owner");
  assert.ok(!("ANTHROPIC_API_KEY" in env), "no stray api key (SDK would prefer it)");
});

test("openrouter models never receive an Anthropic credential var", () => {
  const env = applyOwnerCredentialEnv(
    { OPENROUTER_API_KEY: "sk-or-v1-abc" },
    { kind: "api_key", value: "sk-or-v1-owner" },
    "openrouter/openai/gpt-5.2"
  );
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  // Doc env key wins over the owner's per-user key.
  assert.equal(env.OPENROUTER_API_KEY, "sk-or-v1-abc");
});

// --- per-user provider keys --------------------------------------------------

test("owner's openrouter key fills in when the doc env has none", () => {
  const env = applyOwnerCredentialEnv({}, { kind: "api_key", value: "sk-or-v1-owner" }, "openrouter/openai/gpt-5.2");
  assert.equal(env.OPENROUTER_API_KEY, "sk-or-v1-owner");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("owner's litellm key fills in when the doc env has none", () => {
  const env = applyOwnerCredentialEnv(
    { LITELLM_BASE_URL: "http://host.docker.internal:9274" },
    { kind: "api_key", value: "sk-litellm-owner" },
    "litellm/anthropic/claude-opus-4-8"
  );
  assert.equal(env.LITELLM_API_KEY, "sk-litellm-owner");
  assert.equal(env.LITELLM_BASE_URL, "http://host.docker.internal:9274");
});

test("Codex native OpenAI and LiteLLM models receive only their matching provider key", () => {
  const openai = applyOwnerCredentialEnv(
    {},
    { kind: "api_key", value: "sk-openai-owner" },
    "codex/openai/gpt-5.6-terra"
  );
  assert.equal(openai.OPENAI_API_KEY, "sk-openai-owner");
  assert.equal(openai.ANTHROPIC_API_KEY, undefined);

  const litellm = applyOwnerCredentialEnv(
    { LITELLM_BASE_URL: "http://litellm:4000" },
    { kind: "api_key", value: "sk-litellm-owner" },
    "codex/litellm/anthropic/claude-opus-4-8"
  );
  assert.equal(litellm.LITELLM_API_KEY, "sk-litellm-owner");
  assert.equal(litellm.ANTHROPIC_API_KEY, undefined);
});

test("doc env litellm key wins over the owner's per-user key", () => {
  const env = applyOwnerCredentialEnv(
    { LITELLM_API_KEY: "sk-litellm-doc" },
    { kind: "api_key", value: "sk-litellm-owner" },
    "litellm/openai/gpt-5"
  );
  assert.equal(env.LITELLM_API_KEY, "sk-litellm-doc");
});

test("no owner provider key leaves the env untouched", () => {
  const env = applyOwnerCredentialEnv({ FOO: "bar" }, null, "litellm/openai/gpt-5");
  assert.deepEqual(env, { FOO: "bar" });
});

// --- provider-key fail-fast ---------------------------------------------------

test("providerKeyRequirementError: third-party model with no key anywhere → actionable error", () => {
  assert.match(
    providerKeyRequirementError({}, "openrouter/openai/gpt-5.2") ?? "",
    /OPENROUTER_API_KEY.*Env menu.*AI settings/i
  );
  assert.match(
    providerKeyRequirementError({ LITELLM_API_KEY: "  " }, "litellm/openai/gpt-5") ?? "",
    /LITELLM_API_KEY/
  );
});

test("providerKeyRequirementError: native Codex needs OpenAI key; valid providers pass", () => {
  assert.equal(providerKeyRequirementError({ OPENROUTER_API_KEY: "sk-or-v1-x" }, "openrouter/openai/gpt-5.2"), null);
  assert.equal(providerKeyRequirementError({ LITELLM_API_KEY: "sk-x" }, "litellm/openai/gpt-5"), null);
  assert.equal(providerKeyRequirementError({}, "claude-sonnet-5"), null);
  assert.equal(providerKeyRequirementError({}, null), null);
  assert.match(
    providerKeyRequirementError({}, "codex/openai/gpt-5.6-terra") ?? "",
    /OPENAI_API_KEY.*AI settings/i
  );
  assert.equal(
    providerKeyRequirementError({ OPENAI_API_KEY: "sk-openai" }, "codex/openai/gpt-5.6-terra"),
    null
  );
  assert.equal(
    providerKeyRequirementError({ LITELLM_API_KEY: "sk-x" }, "codex/litellm/anthropic/claude-opus-4-8"),
    null
  );
});

// --- explicit credential requirement ---------------------------------------

test("credentialRequirementError: no credential always gives a clear error", () => {
  const msg = credentialRequirementError({}, "claude-sonnet-5", null, {
    AGENT_REQUIRE_USER_CREDENTIAL: "1"
  });
  assert.match(msg ?? "", /Connect an Anthropic credential/i);
});

test("credentialRequirementError: flag on but a credential is present → ok", () => {
  assert.equal(
    credentialRequirementError({ ANTHROPIC_API_KEY: "sk-ant-x" }, "claude-sonnet-5", null, {
      AGENT_REQUIRE_USER_CREDENTIAL: "1"
    }),
    null
  );
});

test("credentialRequirementError: flag on + openrouter model → ok (uses OPENROUTER_API_KEY)", () => {
  assert.equal(
    credentialRequirementError({}, "openrouter/openai/gpt-5.2", null, {
      AGENT_REQUIRE_USER_CREDENTIAL: "1"
    }),
    null
  );
});

test("host allowlist settings cannot enable fallback, while an account credential works", () => {
  const hostEnv = { AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS: "owner@example.com" };
  assert.match(
    credentialRequirementError({}, "claude-sonnet-5", "owner@example.com", hostEnv) ?? "",
    /Connect an Anthropic credential/i
  );
  assert.equal(
    credentialRequirementError(
      { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" },
      "claude-sonnet-5",
      "stranger@example.com",
      hostEnv
    ),
    null
  );
});

test("openrouter model bypasses the Anthropic requirement", () => {
  assert.equal(
    credentialRequirementError({}, "openrouter/openai/gpt-5.2", "stranger@example.com", {}),
    null
  );
});

test("litellm models never receive the owner's Anthropic credential", () => {
  const env = applyOwnerCredentialEnv(
    { LITELLM_API_KEY: "sk-litellm-abc" },
    { kind: "api_key", value: "sk-ant-owner" },
    "litellm/anthropic/claude-opus-4-8"
  );
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.LITELLM_API_KEY, "sk-litellm-abc");
});

test("credentialRequirementError: litellm model bypasses the requirement and the allowlist", () => {
  assert.equal(
    credentialRequirementError({}, "litellm/openai/gpt-5", null, {
      AGENT_REQUIRE_USER_CREDENTIAL: "1"
    }),
    null
  );
  assert.equal(
    credentialRequirementError({}, "litellm/openai/gpt-5", "stranger@example.com", {
      AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS: "owner@example.com"
    }),
    null
  );
});

// --- tool-credential injection (all providers, regardless of model) --------

test("applyToolCredentialEnv injects every provider key the user has connected", () => {
  const env = applyToolCredentialEnv(
    { FOO: "bar" },
    { openai: "sk-openai-1", openrouter: "sk-or-1", litellm: "llk-1" }
  );
  assert.equal(env.OPENAI_API_KEY, "sk-openai-1");
  assert.equal(env.OPENROUTER_API_KEY, "sk-or-1");
  assert.equal(env.LITELLM_API_KEY, "llk-1");
  assert.equal(env.FOO, "bar");
});

test("applyToolCredentialEnv: document env keys win over user credentials", () => {
  const env = applyToolCredentialEnv(
    { LITELLM_API_KEY: "doc-key", OPENAI_API_KEY: "  " },
    { litellm: "user-key", openai: "sk-openai-user" }
  );
  assert.equal(env.LITELLM_API_KEY, "doc-key");
  // Blank doc value does not block the user credential.
  assert.equal(env.OPENAI_API_KEY, "sk-openai-user");
});

test("applyToolCredentialEnv: missing credentials leave the env untouched", () => {
  const base = { FOO: "bar" };
  assert.deepEqual(applyToolCredentialEnv(base, {}), base);
});
