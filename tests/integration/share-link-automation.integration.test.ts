import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { defaultDocumentContent, serializeDocumentContent } from "../../lib/content";
import { db } from "../../lib/db";
import { seedUser } from "./helpers";

// Regression coverage: a signed-in user whose EDIT access comes from a share
// link (no membership row) manages agent settings like a member — the
// original hardening pass 403'd every viaShareLink access, which surfaced as
// "Failed to save agent settings." when changing the model on a shared doc.
// Anonymous bearers of the same link stay excluded: automation changes need
// an account behind them.
//
// Targets a RUNNING server (GDOCS_TEST_URL, default http://localhost:14141),
// skipping when unreachable — same contract as http.integration.test.ts.

const BASE = process.env.GDOCS_TEST_URL ?? "http://localhost:14141";

let reachablePromise: Promise<boolean> | null = null;
function serverReachable(): Promise<boolean> {
  if (!reachablePromise) {
    reachablePromise = fetch(`${BASE}/api/documents`, { method: "GET" })
      .then(() => true)
      .catch(() => {
        console.warn(`[integration] server not reachable at ${BASE} — skipping share-link-automation suite.`);
        return false;
      });
  }
  return reachablePromise;
}

function itLive(name: string, fn: (t: import("node:test").TestContext) => Promise<void>) {
  test(name, async (t) => {
    if (!(await serverReachable())) {
      t.skip(`server not reachable at ${BASE}`);
      return;
    }
    await fn(t);
  });
}

const createdEmails: string[] = [];

after(async () => {
  for (const email of createdEmails) {
    await db.user.deleteMany({ where: { email } }).catch(() => undefined);
  }
  await db.$disconnect().catch(() => undefined);
});

async function seedDocumentWithEditLink() {
  const email = `int-automation-${crypto.randomUUID()}@example.com`;
  createdEmails.push(email);
  const owner = await db.user.create({
    data: { email, name: "Automation Owner", passwordHash: "not-a-real-hash" },
    select: { id: true }
  });
  const document = await db.document.create({
    data: {
      ownerId: owner.id,
      title: "Automation shared document",
      content: serializeDocumentContent(defaultDocumentContent)
    },
    select: { id: true, title: true }
  });
  const link = await db.shareLink.create({
    data: {
      documentId: document.id,
      createdById: owner.id,
      permission: "EDIT",
      token: crypto.randomBytes(18).toString("base64url")
    },
    select: { token: true }
  });
  return { docId: document.id, title: document.title, token: link.token };
}

itLive("a signed-in user with an EDIT share link can change agent settings", async () => {
  const { docId, title, token } = await seedDocumentWithEditLink();
  const collaborator = await seedUser();
  createdEmails.push(collaborator.email);

  const res = await fetch(`${BASE}/api/documents/${docId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: collaborator.cookie },
    body: JSON.stringify({ title, shareToken: token, agentModel: "claude-opus-4-8", agentEffort: "high" })
  });
  assert.equal(res.status, 200, `agent settings save should succeed, got ${res.status}: ${await res.text()}`);

  const stored = await db.document.findUniqueOrThrow({
    where: { id: docId },
    select: { agentModel: true, agentEffort: true }
  });
  assert.equal(stored.agentModel, "claude-opus-4-8");
  assert.equal(stored.agentEffort, "high");
});

itLive("an anonymous bearer of the same EDIT link cannot change agent settings", async () => {
  const { docId, title, token } = await seedDocumentWithEditLink();

  const res = await fetch(`${BASE}/api/documents/${docId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, shareToken: token, agentModel: "claude-opus-4-8" })
  });
  assert.equal(res.status, 403);

  const stored = await db.document.findUniqueOrThrow({
    where: { id: docId },
    select: { agentModel: true }
  });
  assert.equal(stored.agentModel, null);
});
