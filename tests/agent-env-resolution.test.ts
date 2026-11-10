import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { db } from "../lib/db";
import {
  loadAgentEnvForDocument,
  normalizeCredentialInput,
  upsertUserCredential
} from "../lib/user-credentials";

// Same-process key: credentials created below are decrypted with this key.
process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
// Force strict mode so a run with no resolvable credential fails loudly —
// makes "whose credential was used" observable in every assertion.
process.env.AGENT_REQUIRE_USER_CREDENTIAL = "1";
delete process.env.AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS;

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
    data: { title: "env resolution test", content: JSON.stringify({ type: "doc", content: [] }), ownerId }
  });
  created.documents.push(doc.id);
  return doc;
}

async function connectAnthropicKey(userId: string, value: string) {
  await upsertUserCredential(userId, normalizeCredentialInput({ provider: "anthropic", value }));
}

async function connectHuggingFaceToken(userId: string, value: string) {
  await upsertUserCredential(userId, normalizeCredentialInput({ provider: "huggingface", value }));
}

test.after(async () => {
  await db.document.deleteMany({ where: { id: { in: created.documents } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
  await db.$disconnect();
});

test("runner's credential is used when the doc owner has none", async () => {
  const owner = await makeUser("cred-owner-none");
  const runner = await makeUser("cred-runner");
  await connectAnthropicKey(runner.id, "sk-ant-runner-key");
  const doc = await makeDoc(owner.id);

  const env = await loadAgentEnvForDocument(doc.id, "claude-sonnet-5", runner.id);
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-runner-key");
});

test("runner's credential wins over the owner's when both exist", async () => {
  const owner = await makeUser("cred-owner-both");
  const runner = await makeUser("cred-runner-both");
  await connectAnthropicKey(owner.id, "sk-ant-owner-key");
  await connectAnthropicKey(runner.id, "sk-ant-runner-key");
  const doc = await makeDoc(owner.id);

  const env = await loadAgentEnvForDocument(doc.id, "claude-sonnet-5", runner.id);
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-runner-key");
});

test("a Hugging Face token is injected only for the user who triggered the run", async () => {
  const owner = await makeUser("hf-owner");
  const runner = await makeUser("hf-runner");
  await connectAnthropicKey(runner.id, "sk-ant-runner-key");
  await connectHuggingFaceToken(owner.id, "hf_owner-secret");
  await connectHuggingFaceToken(runner.id, "hf_runner-secret");
  const doc = await makeDoc(owner.id);

  const env = await loadAgentEnvForDocument(doc.id, "claude-sonnet-5", runner.id);
  assert.equal(env.HF_TOKEN, "hf_runner-secret");
});

test("a collaborator-triggered run never falls back to the document owner's Hugging Face token", async () => {
  const owner = await makeUser("hf-private-owner");
  const runner = await makeUser("hf-collaborator");
  await connectAnthropicKey(runner.id, "sk-ant-runner-key");
  await connectHuggingFaceToken(owner.id, "hf_owner-must-not-leak");
  const doc = await makeDoc(owner.id);

  const env = await loadAgentEnvForDocument(doc.id, "claude-sonnet-5", runner.id);
  assert.equal(env.HF_TOKEN, undefined);
});

test("owner's credential still fills in when the runner has none", async () => {
  const owner = await makeUser("cred-owner-only");
  const runner = await makeUser("cred-runner-none");
  await connectAnthropicKey(owner.id, "sk-ant-owner-key");
  const doc = await makeDoc(owner.id);

  const env = await loadAgentEnvForDocument(doc.id, "claude-sonnet-5", runner.id);
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-owner-key");
});

test("document env credential wins over everyone's user credentials", async () => {
  const owner = await makeUser("cred-owner-docenv");
  const runner = await makeUser("cred-runner-docenv");
  await connectAnthropicKey(owner.id, "sk-ant-owner-key");
  await connectAnthropicKey(runner.id, "sk-ant-runner-key");
  const doc = await makeDoc(owner.id);
  const { upsertDocumentEnv } = await import("../lib/document-env");
  await upsertDocumentEnv(doc.id, "ANTHROPIC_API_KEY", "sk-ant-doc-env-key");

  const env = await loadAgentEnvForDocument(doc.id, "claude-sonnet-5", runner.id);
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-doc-env-key");
});

test("no credential anywhere still fails with the connect message", async () => {
  const owner = await makeUser("cred-owner-bare");
  const runner = await makeUser("cred-runner-bare");
  const doc = await makeDoc(owner.id);

  await assert.rejects(
    () => loadAgentEnvForDocument(doc.id, "claude-sonnet-5", runner.id),
    /Connect an Anthropic credential/
  );
});

test("host allowlist never admits a host credential", async () => {
  process.env.AGENT_REQUIRE_USER_CREDENTIAL = "";
  const owner = await makeUser("cred-owner-allow");
  const runner = await makeUser("cred-runner-allow");
  const doc = await makeDoc(owner.id);
  process.env.AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS = runner.email;

  try {
    await assert.rejects(
      () => loadAgentEnvForDocument(doc.id, "claude-sonnet-5", runner.id),
      /Connect an Anthropic credential/
    );
  } finally {
    delete process.env.AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS;
    process.env.AGENT_REQUIRE_USER_CREDENTIAL = "1";
  }
});

// --- Per-run credential policy (lib/run-credential-policy.ts) --------------

test("a run credential policy withholds everything the caller did not allow", async () => {
  const user = await makeUser("cred-policy");
  await connectAnthropicKey(user.id, "sk-ant-policy-key");
  await connectHuggingFaceToken(user.id, "hf_policy_token");
  const doc = await makeDoc(user.id);

  const full = await loadAgentEnvForDocument(doc.id, "claude-sonnet-5", user.id);
  assert.equal(full.HF_TOKEN, "hf_policy_token", "without a policy the user's token reaches the run");

  const restricted = await loadAgentEnvForDocument(doc.id, "claude-sonnet-5", user.id, {
    allowEnv: ["ANTHROPIC_API_KEY"],
    env: { RUNPOD_API_KEY: "rp_for_this_run" },
    allowMcpServers: []
  });
  assert.deepEqual(restricted, { ANTHROPIC_API_KEY: "sk-ant-policy-key", RUNPOD_API_KEY: "rp_for_this_run" });
});

test("a policy that withholds the model's own credential fails before the run starts", async () => {
  const user = await makeUser("cred-policy-missing");
  await connectAnthropicKey(user.id, "sk-ant-policy-key");
  const doc = await makeDoc(user.id);
  await assert.rejects(
    loadAgentEnvForDocument(doc.id, "claude-sonnet-5", user.id, { allowEnv: [], env: {}, allowMcpServers: [] }),
    /credential/i
  );
});

test("the model credential can come from the per-run env alone", async () => {
  const user = await makeUser("cred-policy-run-only");
  const doc = await makeDoc(user.id);
  const env = await loadAgentEnvForDocument(doc.id, "claude-sonnet-5", user.id, {
    allowEnv: [],
    env: { ANTHROPIC_API_KEY: "sk-ant-run-scoped" },
    allowMcpServers: []
  });
  assert.deepEqual(env, { ANTHROPIC_API_KEY: "sk-ant-run-scoped" });
});
