import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { filterInboxThreads } from "../lib/comment-inbox-filter";
import { db } from "../lib/db";
import { listTaggedThreadsForUser } from "../lib/document-data";

async function makeUser(prefix: string) {
  return db.user.create({
    data: { email: `${prefix}-${crypto.randomUUID()}@example.com`, name: prefix, passwordHash: "x" }
  });
}

async function makeDoc(ownerId: string, title: string) {
  return db.document.create({
    data: { title, content: JSON.stringify({ type: "doc", content: [] }), ownerId }
  });
}

async function makeThread(documentId: string, opts: { anchor: string; tags: string[]; status?: string }) {
  const thread = await db.commentThread.create({
    data: {
      documentId,
      anchorText: opts.anchor,
      status: opts.status ?? "OPEN",
      tags: JSON.stringify(opts.tags)
    }
  });
  await db.comment.create({ data: { threadId: thread.id, body: `comment on ${opts.anchor}` } });
  return thread;
}

test("listTaggedThreadsForUser scopes to accessible docs and surfaces tags", async (t) => {
  const owner = await makeUser("owner");
  const collaborator = await makeUser("collab");
  const stranger = await makeUser("stranger");

  const ownedDoc = await makeDoc(owner.id, "Owned doc");
  const sharedDoc = await makeDoc(stranger.id, "Shared doc");
  const hiddenDoc = await makeDoc(stranger.id, "Hidden doc");

  await db.documentMembership.create({
    data: { documentId: sharedDoc.id, userId: collaborator.id, permission: "COMMENT" }
  });

  await makeThread(ownedDoc.id, { anchor: "todo-anchor", tags: ["Todo"] });
  await makeThread(sharedDoc.id, { anchor: "shared-anchor", tags: ["Todo", "Footnote"] });
  await makeThread(hiddenDoc.id, { anchor: "hidden-anchor", tags: ["Todo"] });
  await makeThread(ownedDoc.id, { anchor: "resolved-anchor", tags: [], status: "RESOLVED" });

  t.after(async () => {
    await db.document.deleteMany({ where: { id: { in: [ownedDoc.id, sharedDoc.id, hiddenDoc.id] } } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, collaborator.id, stranger.id] } } });
  });

  // Owner sees their own doc's threads, not the stranger's hidden doc.
  const ownerInbox = await listTaggedThreadsForUser(owner.id);
  const ownerAnchors = ownerInbox.threads.map((t) => t.anchorText).sort();
  assert.deepEqual(ownerAnchors, ["resolved-anchor", "todo-anchor"]);
  assert.ok(ownerInbox.threads.every((t) => t.documentId === ownedDoc.id));
  assert.ok(ownerInbox.tags.includes("Todo"));
  // Resolved is synthesized as a tag whenever a resolved thread exists.
  assert.ok(ownerInbox.tags.includes("Resolved"));

  // Collaborator sees only the shared doc (membership), never the hidden doc.
  const collabInbox = await listTaggedThreadsForUser(collaborator.id);
  assert.deepEqual(
    collabInbox.threads.map((t) => t.anchorText),
    ["shared-anchor"]
  );
  assert.equal(collabInbox.threads[0].documentTitle, "Shared doc");

  // Stranger owns the hidden doc + shared doc originals.
  const strangerInbox = await listTaggedThreadsForUser(stranger.id);
  const strangerAnchors = strangerInbox.threads.map((t) => t.anchorText).sort();
  assert.deepEqual(strangerAnchors, ["hidden-anchor", "shared-anchor"]);
});

test("filterInboxThreads applies AND semantics and hides resolved by default", () => {
  const todo = { status: "OPEN", tags: ["Todo"] };
  const todoFootnote = { status: "OPEN", tags: ["Todo", "Footnote"] };
  const footnote = { status: "OPEN", tags: ["Footnote"] };
  const resolved = { status: "RESOLVED", tags: ["Resolved", "Todo"] };
  const all = [todo, todoFootnote, footnote, resolved];

  // No filter: all open threads, resolved hidden.
  assert.deepEqual(filterInboxThreads(all, []), [todo, todoFootnote, footnote]);

  // Single tag.
  assert.deepEqual(filterInboxThreads(all, ["Todo"]), [todo, todoFootnote]);

  // AND: must have both.
  assert.deepEqual(filterInboxThreads(all, ["Todo", "Footnote"]), [todoFootnote]);

  // Case-insensitive.
  assert.deepEqual(filterInboxThreads(all, ["todo"]), [todo, todoFootnote]);

  // Resolved only appears when explicitly selected.
  assert.deepEqual(filterInboxThreads(all, ["Resolved"]), [resolved]);
  assert.deepEqual(filterInboxThreads(all, ["Resolved", "Todo"]), [resolved]);
});
