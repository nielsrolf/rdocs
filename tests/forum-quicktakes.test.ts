import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { listForumDocumentsForUser } from "../lib/forum-data";
import { canCommentOnDocument, resolveDocumentAccess } from "../lib/permissions";
import {
  createQuicktake,
  deleteQuicktake,
  getQuicktake,
  listQuicktakes,
  QUICKTAKE_KIND,
  QuicktakeError,
  setQuicktakeVisibility
} from "../lib/quicktakes";

// Quicktakes: twitter-like short posts backed by Document rows with kind
// "quicktake". Public by default; a per-user group setting restricts ALL of a
// user's quicktakes retroactively. Excluded from studio dashboard and the
// main forum post list.

async function makeUser(tag: string) {
  return db.user.create({
    data: { email: `qt-${tag}-${crypto.randomUUID()}@example.com`, name: tag, passwordHash: "x" }
  });
}

async function makeGroup(ownerId: string, memberIds: string[] = []) {
  return db.group.create({
    data: {
      name: `qt-group-${crypto.randomUUID().slice(0, 8)}`,
      ownerId,
      members: { create: memberIds.map((userId) => ({ userId, role: "member" })) }
    }
  });
}

async function cleanup({
  documentIds = [],
  groupIds = [],
  userIds = []
}: {
  documentIds?: string[];
  groupIds?: string[];
  userIds?: string[];
}) {
  await db.document.deleteMany({ where: { id: { in: documentIds } } });
  await db.group.deleteMany({ where: { id: { in: groupIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

test("quicktake is public by default: anonymous read + signed-in comment", async () => {
  const owner = await makeUser("owner");
  const stranger = await makeUser("stranger");
  const take = await createQuicktake(owner.id, "Hello **world**, this is a take.");

  try {
    assert.equal(take.isPublic, true);

    const anonymous = await resolveDocumentAccess(take.id, null);
    assert.equal(anonymous?.permission, "VIEW");
    assert.equal(anonymous?.viaForumPublic, true);
    // Logged-out visitors can read but never comment.
    assert.equal(canCommentOnDocument(anonymous!, false), false);

    // Any signed-in user can comment on a forum-public doc (twitter-like).
    const strangerAccess = await resolveDocumentAccess(take.id, stranger.id);
    assert.ok(strangerAccess);
    assert.equal(canCommentOnDocument(strangerAccess!, true), true);

    const fetched = await getQuicktake(take.id, stranger.id);
    assert.equal(fetched?.body, "Hello **world**, this is a take.");
    assert.equal(fetched?.isOwner, false);
  } finally {
    await cleanup({ documentIds: [take.id], userIds: [owner.id, stranger.id] });
  }
});

test("group visibility setting applies to new and existing quicktakes retroactively", async () => {
  const owner = await makeUser("owner");
  const member = await makeUser("member");
  const outsider = await makeUser("outsider");
  const group = await makeGroup(owner.id, [member.id]);

  const before = await createQuicktake(owner.id, "Posted while public");
  const docIds = [before.id];

  try {
    // Restrict to the group: the pre-existing quicktake flips too.
    await setQuicktakeVisibility(owner.id, group.id);
    const after = await createQuicktake(owner.id, "Posted while group-only");
    docIds.push(after.id);
    assert.equal(after.isPublic, false);
    assert.equal(after.groupName, group.name);

    for (const id of docIds) {
      assert.equal(await resolveDocumentAccess(id, null), null, "anonymous locked out");
      assert.equal(await resolveDocumentAccess(id, outsider.id), null, "outsider locked out");
      const memberAccess = await resolveDocumentAccess(id, member.id);
      assert.equal(memberAccess?.permission, "COMMENT", "group member can discuss");
    }

    const memberFeed = (await listQuicktakes(member.id)).map((t) => t.id);
    assert.ok(memberFeed.includes(before.id) && memberFeed.includes(after.id));
    const outsiderFeed = (await listQuicktakes(outsider.id)).map((t) => t.id);
    assert.ok(!outsiderFeed.includes(before.id) && !outsiderFeed.includes(after.id));
    const anonFeed = (await listQuicktakes(null)).map((t) => t.id);
    assert.ok(!anonFeed.includes(before.id) && !anonFeed.includes(after.id));

    // Back to public: both become world-readable again.
    await setQuicktakeVisibility(owner.id, null);
    for (const id of docIds) {
      const anonymous = await resolveDocumentAccess(id, null);
      assert.equal(anonymous?.viaForumPublic, true);
    }
    const grants = await db.documentGroupAccess.count({ where: { documentId: { in: docIds } } });
    assert.equal(grants, 0, "group grants removed when public again");
  } finally {
    await cleanup({ documentIds: docIds, groupIds: [group.id], userIds: [owner.id, member.id, outsider.id] });
  }
});

test("visibility group must be one of the user's groups", async () => {
  const owner = await makeUser("owner");
  const other = await makeUser("other");
  const foreignGroup = await makeGroup(other.id);

  try {
    await assert.rejects(
      () => setQuicktakeVisibility(owner.id, foreignGroup.id),
      QuicktakeError
    );
  } finally {
    await cleanup({ groupIds: [foreignGroup.id], userIds: [owner.id, other.id] });
  }
});

test("quicktakes never appear in the main forum list or accept foreign deletes", async () => {
  const owner = await makeUser("owner");
  const stranger = await makeUser("stranger");
  const take = await createQuicktake(owner.id, "Not a forum post");

  try {
    const forum = await listForumDocumentsForUser(owner.id);
    assert.ok(!forum.some((d) => d.id === take.id), "quicktake filtered from forum posts");

    assert.equal(await deleteQuicktake(stranger.id, take.id), false, "stranger cannot delete");
    assert.equal(await deleteQuicktake(owner.id, take.id), true, "owner deletes");
    const gone = await db.document.findUnique({ where: { id: take.id } });
    assert.equal(gone, null);
  } finally {
    await cleanup({ documentIds: [take.id], userIds: [owner.id, stranger.id] });
  }
});

test("quicktake body validation and title clipping", async () => {
  const owner = await makeUser("owner");
  const docIds: string[] = [];

  try {
    await assert.rejects(() => createQuicktake(owner.id, "   "), QuicktakeError);
    await assert.rejects(() => createQuicktake(owner.id, "x".repeat(4001)), QuicktakeError);

    const long = await createQuicktake(owner.id, `${"word ".repeat(40)}end`);
    docIds.push(long.id);
    const doc = await db.document.findUnique({
      where: { id: long.id },
      select: { title: true, kind: true }
    });
    assert.equal(doc?.kind, QUICKTAKE_KIND);
    assert.ok((doc?.title.length ?? 0) <= 80, "title clipped to 80 chars");
  } finally {
    await cleanup({ documentIds: docIds, userIds: [owner.id] });
  }
});

test("quicktake comment counts exclude resolved threads", async () => {
  const owner = await makeUser("owner");
  const take = await createQuicktake(owner.id, "Count only open comments");
  await db.commentThread.create({
    data: {
      documentId: take.id,
      createdById: owner.id,
      anchorText: "",
      origin: "forum",
      comments: { create: { body: "visible", authorId: owner.id } }
    }
  });
  await db.commentThread.create({
    data: {
      documentId: take.id,
      createdById: owner.id,
      anchorText: "",
      origin: "forum",
      status: "RESOLVED",
      comments: { create: { body: "hidden", authorId: owner.id } }
    }
  });

  try {
    const summary = (await listQuicktakes(owner.id)).find((item) => item.id === take.id);
    assert.equal(summary?.commentCount, 1);
  } finally {
    await cleanup({ documentIds: [take.id], userIds: [owner.id] });
  }
});
