import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { listForumComments } from "../lib/forum-data";

// Forum comments reuse the studio comment system: studio threads surface with
// their anchor text as a quote, forum-origin threads are anchorless roots, and
// Comment.parentId nests replies (studio rendering stays flat and ignores it).

async function makeUser(tag: string) {
  return db.user.create({
    data: { email: `forum-${tag}-${crypto.randomUUID()}@example.com`, name: tag, passwordHash: "x" }
  });
}

async function cleanup(documentIds: string[], userIds: string[]) {
  await db.document.deleteMany({ where: { id: { in: documentIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

test("studio threads appear in forum listing with anchor quote; forum threads without", async () => {
  const owner = await makeUser("owner");
  const doc = await db.document.create({
    data: { ownerId: owner.id, title: "Doc", content: "{}", forumPostedAt: new Date() }
  });

  const studioThread = await db.commentThread.create({
    data: {
      documentId: doc.id,
      createdById: owner.id,
      origin: "studio",
      anchorText: "the disputed sentence",
      comments: { create: { body: "I disagree with this.", authorId: owner.id } }
    }
  });
  const forumThread = await db.commentThread.create({
    data: {
      documentId: doc.id,
      createdById: owner.id,
      origin: "forum",
      anchorText: "",
      comments: { create: { body: "Great post overall!", authorId: owner.id } }
    }
  });

  try {
    const comments = await listForumComments(doc.id, owner.id);
    const studioRoot = comments.find((c) => c.threadId === studioThread.id);
    const forumRoot = comments.find((c) => c.threadId === forumThread.id);
    assert.ok(studioRoot, "studio thread listed");
    assert.equal(studioRoot?.anchorQuote, "the disputed sentence");
    assert.equal(studioRoot?.body, "I disagree with this.");
    assert.ok(forumRoot, "forum thread listed");
    assert.equal(forumRoot?.anchorQuote, null);
  } finally {
    await cleanup([doc.id], [owner.id]);
  }
});

test("resolved threads do not appear in forum comments", async () => {
  const owner = await makeUser("owner");
  const doc = await db.document.create({
    data: { ownerId: owner.id, title: "Doc", content: "{}", forumPostedAt: new Date() }
  });
  const openThread = await db.commentThread.create({
    data: {
      documentId: doc.id,
      createdById: owner.id,
      origin: "forum",
      anchorText: "",
      comments: { create: { body: "still open", authorId: owner.id } }
    }
  });
  const resolvedThread = await db.commentThread.create({
    data: {
      documentId: doc.id,
      createdById: owner.id,
      origin: "forum",
      anchorText: "",
      status: "RESOLVED",
      comments: { create: { body: "already resolved", authorId: owner.id } }
    }
  });

  try {
    const comments = await listForumComments(doc.id, owner.id);
    assert.ok(comments.some((comment) => comment.threadId === openThread.id));
    assert.ok(!comments.some((comment) => comment.threadId === resolvedThread.id));
  } finally {
    await cleanup([doc.id], [owner.id]);
  }
});

test("replies nest under parentId, unknown parent degrades to root child", async () => {
  const owner = await makeUser("owner");
  const replier = await makeUser("replier");
  const doc = await db.document.create({
    data: { ownerId: owner.id, title: "Doc", content: "{}", forumPostedAt: new Date() }
  });
  const thread = await db.commentThread.create({
    data: {
      documentId: doc.id,
      createdById: owner.id,
      origin: "forum",
      anchorText: "",
      comments: { create: { body: "root", authorId: owner.id } }
    },
    include: { comments: true }
  });
  const root = thread.comments[0];
  const child = await db.comment.create({
    data: { threadId: thread.id, parentId: root.id, body: "child", authorId: replier.id }
  });
  await db.comment.create({
    data: { threadId: thread.id, parentId: child.id, body: "grandchild", authorId: owner.id }
  });
  // A reply whose parent is missing/foreign should still show up (under root).
  await db.comment.create({
    data: { threadId: thread.id, parentId: null, body: "flat reply", authorId: replier.id }
  });

  try {
    const comments = await listForumComments(doc.id, owner.id);
    const rootNode = comments.find((c) => c.id === root.id);
    assert.ok(rootNode, "root listed");
    const bodies = rootNode!.replies.map((r) => r.body).sort();
    assert.deepEqual(bodies, ["child", "flat reply"]);
    const childNode = rootNode!.replies.find((r) => r.body === "child");
    assert.deepEqual(childNode?.replies.map((r) => r.body), ["grandchild"]);
  } finally {
    await cleanup([doc.id], [owner.id, replier.id]);
  }
});

test("comment votes aggregate into score and ownVote", async () => {
  const owner = await makeUser("owner");
  const voter = await makeUser("voter");
  const doc = await db.document.create({
    data: { ownerId: owner.id, title: "Doc", content: "{}", forumPostedAt: new Date() }
  });
  const thread = await db.commentThread.create({
    data: {
      documentId: doc.id,
      createdById: owner.id,
      origin: "forum",
      anchorText: "",
      comments: { create: { body: "root", authorId: owner.id } }
    },
    include: { comments: true }
  });
  const root = thread.comments[0];
  await db.commentVote.createMany({
    data: [
      { commentId: root.id, userId: owner.id, value: 1 },
      { commentId: root.id, userId: voter.id, value: -1 }
    ]
  });

  try {
    const forVoter = await listForumComments(doc.id, voter.id);
    const node = forVoter.find((c) => c.id === root.id);
    assert.equal(node?.score, 0);
    assert.equal(node?.ownVote, -1);
    const forOwner = await listForumComments(doc.id, owner.id);
    assert.equal(forOwner.find((c) => c.id === root.id)?.ownVote, 1);
  } finally {
    await cleanup([doc.id], [owner.id, voter.id]);
  }
});
