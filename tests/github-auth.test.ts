import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { db } from "../lib/db";
import { upsertDocumentEnv } from "../lib/document-env";
import { resolveGithubAuthForDocument, resolveGithubAuthForUser } from "../lib/github-auth";
import { normalizeCredentialInput, upsertUserCredential } from "../lib/user-credentials";

process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

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
    data: { title: "github auth test", content: JSON.stringify({ type: "doc", content: [] }), ownerId }
  });
  created.documents.push(doc.id);
  return doc;
}

async function connectGithubPat(userId: string, value: string) {
  await upsertUserCredential(userId, normalizeCredentialInput({ provider: "github", value }));
}

test.after(async () => {
  await db.document.deleteMany({ where: { id: { in: created.documents } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
  await db.$disconnect();
});

// env is passed explicitly so the deployment's real .env values never leak in.
const NO_HOST = {} as Record<string, string | undefined>;

test("document env GITHUB_TOKEN wins over user PATs", async () => {
  const owner = await makeUser("gh-owner-env");
  const runner = await makeUser("gh-runner-env");
  await connectGithubPat(owner.id, "ghp_owner");
  await connectGithubPat(runner.id, "ghp_runner");
  const doc = await makeDoc(owner.id);
  await upsertDocumentEnv(doc.id, "GITHUB_TOKEN", "ghp_docenv");

  const auth = await resolveGithubAuthForDocument(doc.id, runner.id, NO_HOST);
  assert.deepEqual(auth, { token: "ghp_docenv", source: "document-env" });
});

test("runner PAT beats owner PAT; owner PAT fills in when runner has none", async () => {
  const owner = await makeUser("gh-owner");
  const runner = await makeUser("gh-runner");
  const bare = await makeUser("gh-bare");
  await connectGithubPat(owner.id, "ghp_owner");
  await connectGithubPat(runner.id, "ghp_runner");
  const doc = await makeDoc(owner.id);

  assert.deepEqual(await resolveGithubAuthForDocument(doc.id, runner.id, NO_HOST), {
    token: "ghp_runner",
    source: "runner"
  });
  assert.deepEqual(await resolveGithubAuthForDocument(doc.id, bare.id, NO_HOST), {
    token: "ghp_owner",
    source: "owner"
  });
  assert.deepEqual(await resolveGithubAuthForDocument(doc.id, null, NO_HOST), {
    token: "ghp_owner",
    source: "owner"
  });
});

test("host token requires the allowlist to admit the runner or owner", async () => {
  const owner = await makeUser("gh-owner-host");
  const runner = await makeUser("gh-runner-host");
  const doc = await makeDoc(owner.id);

  const hostEnv = (allowed: string | undefined) => ({
    GITHUB_TOKEN: "ghp_host",
    AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS: allowed
  });

  // Runner allowlisted → host token.
  assert.deepEqual(await resolveGithubAuthForDocument(doc.id, runner.id, hostEnv(runner.email)), {
    token: "ghp_host",
    source: "host"
  });
  // Owner allowlisted → host token (background ops on their docs keep working).
  assert.deepEqual(await resolveGithubAuthForDocument(doc.id, runner.id, hostEnv(owner.email)), {
    token: "ghp_host",
    source: "host"
  });
  // Nobody allowlisted → anonymous. This is the fix for the confused-deputy hole.
  assert.equal(
    await resolveGithubAuthForDocument(doc.id, runner.id, hostEnv("someone-else@example.com")),
    null
  );
  // No allowlist configured at all → host token stays open (single-tenant mode).
  assert.deepEqual(
    await resolveGithubAuthForDocument(doc.id, runner.id, hostEnv(undefined)),
    { token: "ghp_host", source: "host" }
  );
  // No host token, nothing else → anonymous.
  assert.equal(await resolveGithubAuthForDocument(doc.id, runner.id, NO_HOST), null);
});

test("resolveGithubAuthForUser: own PAT, else allowlist-gated host token", async () => {
  const user = await makeUser("gh-solo");
  assert.equal(await resolveGithubAuthForUser(user.id, NO_HOST), null);

  await connectGithubPat(user.id, "ghp_solo");
  assert.deepEqual(await resolveGithubAuthForUser(user.id, NO_HOST), {
    token: "ghp_solo",
    source: "runner"
  });

  const other = await makeUser("gh-solo-none");
  assert.equal(
    await resolveGithubAuthForUser(other.id, {
      GITHUB_TOKEN: "ghp_host",
      AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS: "someone-else@example.com"
    }),
    null
  );
  assert.deepEqual(
    await resolveGithubAuthForUser(other.id, { GITHUB_TOKEN: "ghp_host" }),
    { token: "ghp_host", source: "host" }
  );
});

test("github provider round-trips through normalizeCredentialInput", () => {
  assert.deepEqual(normalizeCredentialInput({ provider: "github", value: " ghp_abc123 " }), {
    provider: "github",
    kind: "api_key",
    value: "ghp_abc123"
  });
  assert.throws(
    () => normalizeCredentialInput({ provider: "github", value: "sk-ant-oops" }),
    /looks like an Anthropic credential/
  );
});
