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

test("host allowlist admits the runner, not just the owner", async () => {
  process.env.AGENT_REQUIRE_USER_CREDENTIAL = "";
  const owner = await makeUser("cred-owner-allow");
  const runner = await makeUser("cred-runner-allow");
  const doc = await makeDoc(owner.id);
  process.env.AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS = runner.email;

  try {
    // Runner allowlisted → host fallback permitted (no throw), env left bare.
    const env = await loadAgentEnvForDocument(doc.id, "claude-sonnet-5", runner.id);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);

    // Nobody allowlisted → refused.
    process.env.AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS = "someone-else@example.com";
    await assert.rejects(
      () => loadAgentEnvForDocument(doc.id, "claude-sonnet-5", runner.id),
      /Connect an Anthropic credential/
    );
  } finally {
    delete process.env.AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS;
    process.env.AGENT_REQUIRE_USER_CREDENTIAL = "1";
  }
});
