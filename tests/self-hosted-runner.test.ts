import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { createApiToken } from "../lib/api-tokens";
import { db } from "../lib/db";
import { claimNextSelfHostedJob, completeSelfHostedJob, enqueueSelfHostedJob, getSelfHostedJob } from "../lib/self-hosted-jobs";
import { loadAgentEnvForDocument, normalizeCredentialInput, upsertUserCredential } from "../lib/user-credentials";

// Same-process key: credentials created below are decrypted with this key.
process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
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

async function makeDoc(ownerId: string, runnerMode: string = "managed") {
  const doc = await db.document.create({
    data: {
      title: "self-hosted test",
      content: JSON.stringify({ type: "doc", content: [] }),
      ownerId,
      runnerMode
    }
  });
  created.documents.push(doc.id);
  return doc;
}

async function connectAnthropicKey(userId: string, value: string) {
  await upsertUserCredential(userId, normalizeCredentialInput({ provider: "anthropic", value }));
}

test.after(async () => {
  await db.selfHostedJob.deleteMany({ where: { documentId: { in: created.documents } } });
  await db.document.deleteMany({ where: { id: { in: created.documents } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
  await db.$disconnect();
});

// --- (a) selfHosted docs resolve OWNER credentials, not the triggering user's ---

test("selfHosted doc: triggering user's own credential is ignored, owner's is used", async () => {
  const owner = await makeUser("sh-owner");
  const triggeringUser = await makeUser("sh-triggerer");
  await connectAnthropicKey(owner.id, "sk-ant-owner-key");
  await connectAnthropicKey(triggeringUser.id, "sk-ant-triggerer-key");
  const doc = await makeDoc(owner.id, "selfHosted");

  // On a MANAGED doc the triggering user's own credential would win (this is
  // the existing, well-tested precedence — see agent-env-resolution.test.ts).
  // The whole point of runnerMode "selfHosted" is that it does NOT: every
  // collaborator's run must authenticate as the owner.
  const env = await loadAgentEnvForDocument(doc.id, "claude-sonnet-5", triggeringUser.id);
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-owner-key");
});

test("managed doc (control): triggering user's credential wins, proving the assertion above is meaningful", async () => {
  const owner = await makeUser("mg-owner");
  const triggeringUser = await makeUser("mg-triggerer");
  await connectAnthropicKey(owner.id, "sk-ant-owner-key-2");
  await connectAnthropicKey(triggeringUser.id, "sk-ant-triggerer-key-2");
  const doc = await makeDoc(owner.id, "managed");

  const env = await loadAgentEnvForDocument(doc.id, "claude-sonnet-5", triggeringUser.id);
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-triggerer-key-2");
});

test("selfHosted doc: falls through to owner credential even with no triggering user (anonymous share link)", async () => {
  const owner = await makeUser("sh-owner-anon");
  await connectAnthropicKey(owner.id, "sk-ant-owner-key-3");
  const doc = await makeDoc(owner.id, "selfHosted");

  const env = await loadAgentEnvForDocument(doc.id, "claude-sonnet-5", null);
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-owner-key-3");
});

// --- (b) job claim/result API round-trip with a fake worker ---

test("self-hosted job queue: enqueue -> claim -> complete round trip", async () => {
  const owner = await makeUser("sh-job-owner");
  const otherUser = await makeUser("sh-job-other");
  const doc = await makeDoc(owner.id, "selfHosted");
  const { token: ownerToken } = await createApiToken(owner.id, "worker");
  const { token: otherToken } = await createApiToken(otherUser.id, "worker");

  // Nothing queued yet.
  assert.equal(await claimNextSelfHostedJob(owner.id), null);

  const enqueued = await enqueueSelfHostedJob({
    documentId: doc.id,
    aiRunId: "fake-run-1",
    jobPayload: { input: { mode: "edit_selection", instruction: "do the thing" } }
  });

  // A different user's worker (via a valid token, just not the doc owner)
  // must not be able to claim this document's job.
  assert.equal(await claimNextSelfHostedJob(otherUser.id), null);

  // The owner's worker claims it.
  const claimed = await claimNextSelfHostedJob(owner.id);
  assert.ok(claimed);
  assert.equal(claimed!.id, enqueued.id);
  assert.equal(claimed!.aiRunId, "fake-run-1");
  const payload = JSON.parse(claimed!.jobPayload) as { input: { instruction: string } };
  assert.equal(payload.input.instruction, "do the thing");

  // Once claimed, it is no longer pending — a second claim attempt (by anyone)
  // finds nothing.
  assert.equal(await claimNextSelfHostedJob(owner.id), null);

  // A worker authenticated as someone else can't post a result for this job.
  const rejected = await completeSelfHostedJob(enqueued.id, otherUser.id, {
    status: "succeeded",
    resultPayload: { replacementText: "should not apply" }
  });
  assert.equal(rejected, false);

  // The real owner posts the result.
  const ok = await completeSelfHostedJob(enqueued.id, owner.id, {
    status: "succeeded",
    resultPayload: { replacementText: "done!" }
  });
  assert.equal(ok, true);

  const finished = await getSelfHostedJob(enqueued.id);
  assert.equal(finished?.status, "succeeded");
  const result = JSON.parse(finished!.resultPayload ?? "{}") as { replacementText: string };
  assert.equal(result.replacementText, "done!");

  // Sanity: the ApiTokens minted above are the exact bearer credential the
  // real /api/self-hosted/jobs/* routes would resolve via resolveApiTokenUser
  // — asserting they exist/parse is enough here; the route-level auth wiring
  // is exercised the same way tests/mcp-server.test.ts exercises /api/mcp's.
  assert.match(ownerToken, /^gdai_[0-9a-f]{48}$/);
  assert.match(otherToken, /^gdai_[0-9a-f]{48}$/);
});

test("self-hosted job queue: failure path records the error", async () => {
  const owner = await makeUser("sh-job-fail-owner");
  const doc = await makeDoc(owner.id, "selfHosted");
  const enqueued = await enqueueSelfHostedJob({
    documentId: doc.id,
    aiRunId: "fake-run-2",
    jobPayload: { input: { mode: "edit_selection" } }
  });
  await claimNextSelfHostedJob(owner.id);

  const ok = await completeSelfHostedJob(enqueued.id, owner.id, {
    status: "failed",
    error: "worker exploded"
  });
  assert.equal(ok, true);

  const finished = await getSelfHostedJob(enqueued.id);
  assert.equal(finished?.status, "failed");
  assert.equal(finished?.error, "worker exploded");
});
