import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { serializeDocumentContent } from "../lib/content";
import { listDocumentThreads, maybeCreateVersionSnapshot } from "../lib/document-data";
import { db } from "../lib/db";
import { serializeSourceLinks } from "../lib/sources";

// Regression coverage for "saving comments sometimes failed" and "sometimes
// comments were not displayed". listDocumentThreads is what the workspace reads
// to render the comment rail; it must return every thread with its comments and
// the correct per-user read state. maybeCreateVersionSnapshot is the safety net
// that keeps pre-overwrite content recoverable.

function contentWithText(text: string) {
  return serializeDocumentContent({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }]
  });
}

async function createDoc() {
  const user = await db.user.create({
    data: { email: `cmt-${crypto.randomUUID()}@example.com`, name: "Cmt Test", passwordHash: "x" }
  });
  const document = await db.document.create({
    data: { title: "Comments test", content: contentWithText("body"), ownerId: user.id }
  });
  return { user, document };
}

async function cleanup(userId: string, documentId: string) {
  await db.document.delete({ where: { id: documentId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
}

test("listDocumentThreads returns every thread with its comments (display)", async () => {
  const { user, document } = await createDoc();
  try {
    const thread1 = await db.commentThread.create({
      data: { documentId: document.id, createdById: user.id, anchorText: "first anchor" }
    });
    await db.comment.create({
      data: { threadId: thread1.id, authorId: user.id, body: "human comment" }
    });
    await db.comment.create({
      data: {
        threadId: thread1.id,
        body: "AI reply",
        aiModel: "claude-agent-sdk:sonnet",
        sourceLinks: serializeSourceLinks(["https://example.com/a"])
      }
    });
    const thread2 = await db.commentThread.create({
      data: { documentId: document.id, createdById: user.id, anchorText: "second anchor" }
    });
    await db.comment.create({ data: { threadId: thread2.id, authorId: user.id, body: "only comment" } });

    const threads = await listDocumentThreads(document.id, user.id);
    assert.equal(threads.length, 2, "both threads must be displayed");

    const t1 = threads.find((t) => t.id === thread1.id)!;
    assert.equal(t1.comments.length, 2);
    assert.equal(t1.comments[0].body, "human comment");
    assert.equal(t1.comments[1].body, "AI reply");
    assert.equal(t1.comments[1].aiModel, "claude-agent-sdk:sonnet");
    assert.deepEqual(t1.comments[1].sourceLinks, ["https://example.com/a"]);

    const t2 = threads.find((t) => t.id === thread2.id)!;
    assert.equal(t2.comments.length, 1);
  } finally {
    await cleanup(user.id, document.id);
  }
});

test("listDocumentThreads reports per-user read state", async () => {
  const { user, document } = await createDoc();
  try {
    const readThread = await db.commentThread.create({
      data: { documentId: document.id, createdById: user.id, anchorText: "read" }
    });
    const unreadThread = await db.commentThread.create({
      data: { documentId: document.id, createdById: user.id, anchorText: "unread" }
    });
    const readAt = new Date();
    await db.commentThreadRead.create({
      data: { threadId: readThread.id, userId: user.id, lastReadAt: readAt }
    });

    const threads = await listDocumentThreads(document.id, user.id);
    const read = threads.find((t) => t.id === readThread.id)!;
    const unread = threads.find((t) => t.id === unreadThread.id)!;
    assert.ok(read.lastReadAt, "read thread has a lastReadAt");
    assert.equal(unread.lastReadAt, null, "unread thread has no lastReadAt");
  } finally {
    await cleanup(user.id, document.id);
  }
});

test("an orphaned thread (anchor text gone from doc) is still listed so it can be surfaced", async () => {
  const { user, document } = await createDoc();
  try {
    // The document body never contains this anchor text — the thread is detached.
    const orphan = await db.commentThread.create({
      data: { documentId: document.id, createdById: user.id, anchorText: "text that was deleted" }
    });
    await db.comment.create({ data: { threadId: orphan.id, authorId: user.id, body: "still here" } });

    const threads = await listDocumentThreads(document.id, user.id);
    assert.ok(threads.some((t) => t.id === orphan.id), "orphan thread must still be returned");
  } finally {
    await cleanup(user.id, document.id);
  }
});

test("maybeCreateVersionSnapshot archives the previous content on a real change", async () => {
  const { user, document } = await createDoc();
  try {
    await maybeCreateVersionSnapshot({
      documentId: document.id,
      currentTitle: "Comments test",
      currentContent: contentWithText("the original body"),
      nextTitle: "Comments test",
      nextContent: contentWithText("a rewritten body")
    });

    const versions = await db.documentVersion.findMany({ where: { documentId: document.id } });
    assert.ok(versions.length >= 1, "a snapshot of the pre-change content must exist");
    assert.ok(
      versions.some((v) => v.content === contentWithText("the original body")),
      "the previous content is recoverable"
    );
  } finally {
    await cleanup(user.id, document.id);
  }
});

test("maybeCreateVersionSnapshot is a no-op when nothing changed", async () => {
  const { user, document } = await createDoc();
  try {
    const same = contentWithText("unchanged");
    await maybeCreateVersionSnapshot({
      documentId: document.id,
      currentTitle: "Comments test",
      currentContent: same,
      nextTitle: "Comments test",
      nextContent: same
    });
    const count = await db.documentVersion.count({ where: { documentId: document.id } });
    assert.equal(count, 0);
  } finally {
    await cleanup(user.id, document.id);
  }
});
