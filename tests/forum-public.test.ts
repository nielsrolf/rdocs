import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { resolveDocumentAccess } from "../lib/permissions";
import { listForumDocumentsForUser } from "../lib/forum-data";

// Public forum posts (forumPostedAt + forumPublic) are readable by EVERYONE —
// including viewers with no account at all. Public visibility is strictly
// VIEW; commenting/voting stay sign-in-gated in their routes.

async function makeUser(tag: string) {
  return db.user.create({
    data: { email: `pub-${tag}-${crypto.randomUUID()}@example.com`, name: tag, passwordHash: "x" }
  });
}

async function makeDocument(ownerId: string, extra: Record<string, unknown> = {}) {
  return db.document.create({
    data: { ownerId, title: "Public forum doc", content: "{}", ...extra }
  });
}

async function cleanup(documentIds: string[], userIds: string[]) {
  await db.document.deleteMany({ where: { id: { in: documentIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

test("public forum post grants anonymous and stranger VIEW access", async () => {
  const owner = await makeUser("owner");
  const stranger = await makeUser("stranger");
  const doc = await makeDocument(owner.id, { forumPostedAt: new Date(), forumPublic: true });

  try {
    const anonymous = await resolveDocumentAccess(doc.id, null);
    assert.ok(anonymous, "anonymous viewer gets access");
    assert.equal(anonymous?.permission, "VIEW");
    assert.equal(anonymous?.viaForumPublic, true);
    assert.equal(anonymous?.viaShareLink, false);

    const strangerAccess = await resolveDocumentAccess(doc.id, stranger.id);
    assert.equal(strangerAccess?.permission, "VIEW");
    assert.equal(strangerAccess?.viaForumPublic, true);

    // The owner keeps full access — the public grant never downgrades.
    const ownerAccess = await resolveDocumentAccess(doc.id, owner.id);
    assert.equal(ownerAccess?.permission, "EDIT");
    assert.equal(ownerAccess?.viaForumPublic, false);
  } finally {
    await cleanup([doc.id], [owner.id, stranger.id]);
  }
});

test("public flag alone (unposted) or posting alone (private) grants nothing", async () => {
  const owner = await makeUser("owner");
  const publicUnposted = await makeDocument(owner.id, { forumPublic: true });
  const postedPrivate = await makeDocument(owner.id, { forumPostedAt: new Date() });

  try {
    assert.equal(await resolveDocumentAccess(publicUnposted.id, null), null);
    assert.equal(await resolveDocumentAccess(postedPrivate.id, null), null);
  } finally {
    await cleanup([publicUnposted.id, postedPrivate.id], [owner.id]);
  }
});

test("forum frontpage lists public posts for anonymous viewers and strangers", async () => {
  const owner = await makeUser("owner");
  const stranger = await makeUser("stranger");
  const publicPost = await makeDocument(owner.id, {
    forumPostedAt: new Date(),
    forumPublic: true,
    title: "Public"
  });
  const privatePost = await makeDocument(owner.id, { forumPostedAt: new Date(), title: "Private" });

  try {
    const anonymousList = await listForumDocumentsForUser(null);
    const anonymousIds = anonymousList.map((d) => d.id);
    assert.ok(anonymousIds.includes(publicPost.id), "anonymous sees public post");
    assert.ok(!anonymousIds.includes(privatePost.id), "anonymous never sees private post");

    const strangerList = await listForumDocumentsForUser(stranger.id);
    const strangerIds = strangerList.map((d) => d.id);
    assert.ok(strangerIds.includes(publicPost.id), "stranger sees public post");
    assert.ok(!strangerIds.includes(privatePost.id), "stranger never sees private post");
  } finally {
    await cleanup([publicPost.id, privatePost.id], [owner.id, stranger.id]);
  }
});

test("forum post comment counts exclude resolved threads", async () => {
  const owner = await makeUser("owner");
  const post = await makeDocument(owner.id, {
    forumPostedAt: new Date(),
    forumPublic: true
  });
  await db.commentThread.create({
    data: {
      documentId: post.id,
      createdById: owner.id,
      anchorText: "",
      origin: "forum",
      comments: { create: [{ body: "open root", authorId: owner.id }, { body: "open reply", authorId: owner.id }] }
    }
  });
  await db.commentThread.create({
    data: {
      documentId: post.id,
      createdById: owner.id,
      anchorText: "",
      origin: "forum",
      status: "RESOLVED",
      comments: { create: { body: "hidden resolved comment", authorId: owner.id } }
    }
  });

  try {
    const summary = (await listForumDocumentsForUser(owner.id)).find((item) => item.id === post.id);
    assert.equal(summary?.commentCount, 2);
  } finally {
    await cleanup([post.id], [owner.id]);
  }
});
