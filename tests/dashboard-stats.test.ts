import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { serializeDocumentContent } from "../lib/content";
import { getDocumentCommentStats } from "../lib/document-data";
import { db } from "../lib/db";

// Locks the dashboard unread-count semantics now that it is computed in SQL:
// a comment counts as unread iff its thread is not RESOLVED, it was not authored
// by the viewer, and it was created after the viewer last read that thread.

function content() {
  return serializeDocumentContent({ type: "doc", content: [{ type: "paragraph" }] });
}

async function makeUserAndDoc(label: string) {
  const user = await db.user.create({
    data: { email: `dash-${label}-${crypto.randomUUID()}@example.com`, name: label, passwordHash: "x" }
  });
  const document = await db.document.create({
    data: { title: "Dash test", content: content(), ownerId: user.id }
  });
  return { user, document };
}

test("counts only unread, non-resolved, not-own comments and tracks the last comment time", async () => {
  const { user: viewer, document } = await makeUserAndDoc("viewer");
  const other = await db.user.create({
    data: { email: `dash-other-${crypto.randomUUID()}@example.com`, name: "Other", passwordHash: "x" }
  });
  try {
    // Open thread with: one comment by another user (unread), one by the viewer
    // (never unread), one AI comment with null author (unread).
    const openThread = await db.commentThread.create({
      data: { documentId: document.id, createdById: viewer.id, anchorText: "a" }
    });
    await db.comment.create({ data: { threadId: openThread.id, authorId: other.id, body: "from other" } });
    await db.comment.create({ data: { threadId: openThread.id, authorId: viewer.id, body: "my own" } });
    const aiComment = await db.comment.create({
      data: { threadId: openThread.id, body: "AI reply", aiModel: "x" }
    });

    // Resolved thread: its comments never count as unread.
    const resolvedThread = await db.commentThread.create({
      data: { documentId: document.id, createdById: viewer.id, anchorText: "b", status: "RESOLVED" }
    });
    await db.comment.create({ data: { threadId: resolvedThread.id, authorId: other.id, body: "resolved comment" } });

    const before = await getDocumentCommentStats(viewer.id, [document.id]);
    assert.equal(before.unreadByDoc.get(document.id), 2, "other + AI comment are unread; own + resolved are not");
    assert.ok(before.lastCommentByDoc.get(document.id), "last comment time is tracked");

    // After the viewer reads the open thread (now), nothing in it is unread.
    await db.commentThreadRead.create({
      data: { threadId: openThread.id, userId: viewer.id, lastReadAt: new Date(aiComment.createdAt.getTime() + 1000) }
    });
    const after = await getDocumentCommentStats(viewer.id, [document.id]);
    assert.equal(after.unreadByDoc.get(document.id) ?? 0, 0, "reading the thread clears unread");
  } finally {
    await db.document.delete({ where: { id: document.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: viewer.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: other.id } }).catch(() => undefined);
  }
});

test("returns empty maps for no documents", async () => {
  const stats = await getDocumentCommentStats("nobody", []);
  assert.equal(stats.unreadByDoc.size, 0);
  assert.equal(stats.lastCommentByDoc.size, 0);
});

test("a comment created after lastReadAt is unread again", async () => {
  const { user: viewer, document } = await makeUserAndDoc("viewer2");
  const other = await db.user.create({
    data: { email: `dash-other2-${crypto.randomUUID()}@example.com`, name: "Other2", passwordHash: "x" }
  });
  try {
    const thread = await db.commentThread.create({
      data: { documentId: document.id, createdById: viewer.id, anchorText: "c" }
    });
    // Read marker BEFORE the comment exists.
    await db.commentThreadRead.create({
      data: { threadId: thread.id, userId: viewer.id, lastReadAt: new Date(Date.now() - 60_000) }
    });
    await db.comment.create({ data: { threadId: thread.id, authorId: other.id, body: "newer than read" } });

    const stats = await getDocumentCommentStats(viewer.id, [document.id]);
    assert.equal(stats.unreadByDoc.get(document.id), 1);
  } finally {
    await db.document.delete({ where: { id: document.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: viewer.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: other.id } }).catch(() => undefined);
  }
});
