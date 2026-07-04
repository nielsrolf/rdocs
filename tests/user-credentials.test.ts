import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import {
  applyOwnerCredentialEnv,
  credentialRequirementError,
  decryptSecret,
  detectCredentialKind,
  encryptSecret,
  normalizeCredentialInput
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
    kind: "api_key",
    value: "sk-ant-api03-xyz"
  });
  assert.deepEqual(normalizeCredentialInput({ value: "sk-ant-oat01-abc" }), {
    kind: "oauth",
    value: "sk-ant-oat01-abc"
  });
  // Explicit kind that agrees is accepted.
  assert.deepEqual(normalizeCredentialInput({ kind: "oauth", value: "sk-ant-oat01-abc" }), {
    kind: "oauth",
    value: "sk-ant-oat01-abc"
  });
  // Explicit kind that disagrees is rejected.
  assert.throws(() => normalizeCredentialInput({ kind: "api_key", value: "sk-ant-oat01-abc" }), /looks like/i);
  // Unrecognized prefix rejected.
  assert.throws(() => normalizeCredentialInput({ value: "garbage" }), /Anthropic API key/i);
  // Empty rejected.
  assert.throws(() => normalizeCredentialInput({ value: "   " }), /required/i);
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

test("resolution precedence: no owner credential leaves env untouched for host fallback", () => {
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

test("openrouter models never receive the owner's Anthropic credential", () => {
  const env = applyOwnerCredentialEnv(
    { OPENROUTER_API_KEY: "sk-or-v1-abc" },
    { kind: "api_key", value: "sk-ant-owner" },
    "openrouter/openai/gpt-5.2"
  );
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.OPENROUTER_API_KEY, "sk-or-v1-abc");
});

// --- phase-4 flag behavior -------------------------------------------------

test("credentialRequirementError: off by default (no flag)", () => {
  assert.equal(credentialRequirementError({}, "claude-sonnet-5", {}), null);
});

test("credentialRequirementError: flag on + no credential → clear error", () => {
  const msg = credentialRequirementError({}, "claude-sonnet-5", { AGENT_REQUIRE_USER_CREDENTIAL: "1" });
  assert.match(msg ?? "", /Connect an Anthropic credential/i);
});

test("credentialRequirementError: flag on but a credential is present → ok", () => {
  assert.equal(
    credentialRequirementError({ ANTHROPIC_API_KEY: "sk-ant-x" }, "claude-sonnet-5", {
      AGENT_REQUIRE_USER_CREDENTIAL: "1"
    }),
    null
  );
});

test("credentialRequirementError: flag on + openrouter model → ok (uses OPENROUTER_API_KEY)", () => {
  assert.equal(
    credentialRequirementError({}, "openrouter/openai/gpt-5.2", { AGENT_REQUIRE_USER_CREDENTIAL: "1" }),
    null
  );
});
