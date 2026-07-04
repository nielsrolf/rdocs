import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { defaultDocumentContent, serializeDocumentContent } from "../../lib/content";
import { db } from "../../lib/db";

// Regression coverage for anonymous (not-logged-in) commenting via share links.
// A recipient of an EDIT or COMMENT share link has no session cookie, but must
// still be able to create comment threads and reply — the same way they can
// already pull/push collab steps and trigger AI edits with just the token.
//
// Owner/document/link fixtures are seeded directly through Prisma rather than
// the sign-up route: the http.integration suite already uses the full
// 10-per-minute sign-up rate-limit budget, and every request under test here
// is anonymous anyway.
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
        console.warn(`[integration] server not reachable at ${BASE} — skipping anonymous-comment suite.`);
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
  // Deleting the users cascades to their documents, threads, and share links.
  for (const email of createdEmails) {
    await db.user.deleteMany({ where: { email } }).catch(() => undefined);
  }
  await db.$disconnect().catch(() => undefined);
});

// No session cookie: the anonymous share-link recipient.
function anon(url: string, init: RequestInit = {}) {
  return fetch(`${BASE}${url}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
  });
}

async function seedDocumentWithLink(permission: "VIEW" | "COMMENT" | "EDIT") {
  const email = `int-anon-${crypto.randomUUID()}@example.com`;
  createdEmails.push(email);
  const owner = await db.user.create({
    data: { email, name: "Share Link Owner", passwordHash: "not-a-real-hash" },
    select: { id: true }
  });
  const document = await db.document.create({
    data: {
      ownerId: owner.id,
      title: "Shared document",
      content: serializeDocumentContent(defaultDocumentContent)
    },
    select: { id: true }
  });
  const link = await db.shareLink.create({
    data: {
      documentId: document.id,
      createdById: owner.id,
      permission,
      token: crypto.randomBytes(18).toString("base64url")
    },
    select: { token: true }
  });
  return { docId: document.id, token: link.token };
}

itLive("anonymous user with an EDIT share link can create a thread and reply", async () => {
  const { docId, token } = await seedDocumentWithLink("EDIT");

  const create = await anon(`/api/documents/${docId}/comments`, {
    method: "POST",
    body: JSON.stringify({
      body: "comment from an anonymous editor",
      anchorText: "some text",
      shareToken: token,
      guestName: "Ada"
    })
  });
  assert.equal(create.status, 200, "anonymous comment via EDIT link should succeed");
  const created = await create.json();
  assert.ok(created.thread?.id, "thread returned");
  assert.equal(created.thread.comments[0].body, "comment from an anonymous editor");
  assert.equal(created.thread.comments[0].author, null, "anonymous comment has no user author");
  assert.equal(created.thread.comments[0].guestName, "Ada", "guest name is preserved");

  const reply = await anon(`/api/comments/${created.thread.id}/reply`, {
    method: "POST",
    body: JSON.stringify({ body: "anonymous reply", shareToken: token, guestName: "Ada" })
  });
  assert.equal(reply.status, 200, "anonymous reply via EDIT link should succeed");
  const replied = await reply.json();
  assert.equal(replied.comment.body, "anonymous reply");
  assert.equal(replied.comment.guestName, "Ada");

  // The thread and both comments survive a reload through the anonymous view.
  const get = await anon(`/api/documents/${docId}?share=${encodeURIComponent(token)}`);
  assert.equal(get.status, 200, "anonymous document GET via share token should succeed");
  const data = await get.json();
  const thread = data.threads.find((t: { id: string }) => t.id === created.thread.id);
  assert.ok(thread, "thread visible on reload");
  assert.deepEqual(
    thread.comments.map((c: { body: string }) => c.body),
    ["comment from an anonymous editor", "anonymous reply"]
  );
});

itLive("anonymous user with a COMMENT share link can comment; VIEW link cannot", async () => {
  const commentLink = await seedDocumentWithLink("COMMENT");
  const commentRes = await anon(`/api/documents/${commentLink.docId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: "via comment link", anchorText: "anchor", shareToken: commentLink.token })
  });
  assert.equal(commentRes.status, 200, "COMMENT link should allow anonymous comments");
  const created = await commentRes.json();
  assert.equal(created.thread.comments[0].guestName, "Guest", "guest name defaults to Guest");

  const viewLink = await seedDocumentWithLink("VIEW");
  const viewRes = await anon(`/api/documents/${viewLink.docId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: "via view link", anchorText: "anchor", shareToken: viewLink.token })
  });
  assert.ok([401, 403].includes(viewRes.status), "VIEW link must not allow commenting");
});

itLive("anonymous user without a share token cannot comment", async () => {
  const { docId } = await seedDocumentWithLink("EDIT");

  const res = await anon(`/api/documents/${docId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: "no token", anchorText: "anchor" })
  });
  assert.ok([401, 403].includes(res.status), "no session and no token must be rejected");

  const revoked = await anon(`/api/documents/${docId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: "bad token", anchorText: "anchor", shareToken: "not-a-real-token" })
  });
  assert.ok([401, 403].includes(revoked.status), "an invalid token must be rejected");
});
