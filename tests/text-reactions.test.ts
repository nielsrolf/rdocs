import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { listDocumentThreads } from "../lib/document-data";
import { listForumComments } from "../lib/forum-data";
import { createReactionThread, toggleCommentReaction } from "../lib/reaction-data";

// A Google-Docs-style emoji reaction on document text is a CommentThread with
// origin "reaction": the root comment's body mirrors its emoji, its
// CommentReaction rows are the pills in the margin, and removing the last one
// deletes the thread.

async function makeUser(tag: string) {
  return db.user.create({
    data: { email: `tr-${tag}-${crypto.randomUUID()}@example.com`, name: tag, passwordHash: "x" }
  });
}

test("text reaction lifecycle: create, join, switch emoji, last removal deletes the thread", async () => {
  const ann = await makeUser("ann");
  const bo = await makeUser("bo");
  const doc = await db.document.create({
    data: { title: "reactions", content: "{}", ownerId: ann.id, forumPostedAt: new Date() }
  });
  try {
    const thread = await createReactionThread({
      documentId: doc.id,
      userId: ann.id,
      emoji: "🔥",
      anchorText: "a hot take"
    });
    const root = thread.comments[0];
    assert.equal(thread.origin, "reaction");
    assert.equal(root.body, "🔥");
    assert.deepEqual(root.reactions.map((r) => [r.emoji, r.userId]), [["🔥", ann.id]]);

    // Serialized for the editor with origin and per-viewer flags.
    const [listed] = await listDocumentThreads(doc.id, bo.id);
    assert.equal(listed.origin, "reaction");
    assert.deepEqual(
      listed.comments[0].reactions.map((r) => [r.emoji, r.count, r.reactedByMe]),
      [["🔥", 1, false]]
    );

    // Not a forum comment.
    assert.deepEqual(await listForumComments(doc.id, ann.id), []);

    const toggle = (userId: string, emoji: string) =>
      toggleCommentReaction({ commentId: root.id, threadId: thread.id, threadOrigin: "reaction", userId, emoji });

    let result = await toggle(bo.id, "➕");
    assert.equal(result.deletedThreadId, null);
    assert.equal((await db.comment.findUniqueOrThrow({ where: { id: root.id } })).body, "➕ 🔥");

    result = await toggle(ann.id, "🔥");
    assert.equal(result.deletedThreadId, null);
    assert.equal((await db.comment.findUniqueOrThrow({ where: { id: root.id } })).body, "➕");

    result = await toggle(bo.id, "➕");
    assert.equal(result.deletedThreadId, thread.id);
    assert.equal(await db.commentThread.findUnique({ where: { id: thread.id } }), null);
  } finally {
    await db.document.delete({ where: { id: doc.id } });
    await db.user.deleteMany({ where: { id: { in: [ann.id, bo.id] } } });
  }
});

test("removing the last reaction on an ordinary comment keeps the comment", async () => {
  const ann = await makeUser("ann2");
  const doc = await db.document.create({ data: { title: "reactions", content: "{}", ownerId: ann.id } });
  try {
    const thread = await db.commentThread.create({
      data: {
        documentId: doc.id,
        createdById: ann.id,
        anchorText: "x",
        comments: { create: { body: "A real comment", authorId: ann.id } }
      },
      select: { id: true, origin: true, comments: { select: { id: true } } }
    });
    const commentId = thread.comments[0].id;
    const toggle = () =>
      toggleCommentReaction({ commentId, threadId: thread.id, threadOrigin: thread.origin, userId: ann.id, emoji: "🎉" });
    await toggle();
    const result = await toggle();
    assert.equal(result.deletedThreadId, null);
    assert.deepEqual(result.rows, []);
    assert.equal((await db.comment.findUniqueOrThrow({ where: { id: commentId } })).body, "A real comment");
  } finally {
    await db.document.delete({ where: { id: doc.id } });
    await db.user.delete({ where: { id: ann.id } });
  }
});
