import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { listForumPostCandidates, publishForumPost } from "../lib/forum-posting";

async function makeUser(tag: string) {
  return db.user.create({
    data: { email: `forum-post-${tag}-${crypto.randomUUID()}@example.com`, name: tag, passwordHash: "x" }
  });
}

async function makeDocument(ownerId: string, extra: Record<string, unknown> = {}) {
  return db.document.create({
    data: { ownerId, title: "Candidate", content: "{}", ...extra }
  });
}

test("forum post picker lists only unposted editable documents", async () => {
  const owner = await makeUser("owner");
  const editor = await makeUser("editor");
  const owned = await makeDocument(editor.id, { title: "Owned" });
  const directEdit = await makeDocument(owner.id, { title: "Direct edit" });
  const directView = await makeDocument(owner.id, { title: "Direct view" });
  const posted = await makeDocument(editor.id, { title: "Already posted", forumPostedAt: new Date() });
  const quicktake = await makeDocument(editor.id, { title: "Quicktake", kind: "quicktake" });
  await db.documentMembership.createMany({
    data: [
      { documentId: directEdit.id, userId: editor.id, permission: "EDIT" },
      { documentId: directView.id, userId: editor.id, permission: "VIEW" }
    ]
  });

  try {
    const candidates = await listForumPostCandidates(editor.id);
    const ids = candidates.map((document) => document.id);
    assert.ok(ids.includes(owned.id));
    assert.ok(ids.includes(directEdit.id));
    assert.ok(!ids.includes(directView.id));
    assert.ok(!ids.includes(posted.id));
    assert.ok(!ids.includes(quicktake.id));
  } finally {
    await db.document.deleteMany({
      where: { id: { in: [owned.id, directEdit.id, directView.id, posted.id, quicktake.id] } }
    });
    await db.user.deleteMany({ where: { id: { in: [owner.id, editor.id] } } });
  }
});

test("publishing to a group shares VIEW access and posts privately in one operation", async () => {
  const owner = await makeUser("owner");
  const member = await makeUser("member");
  const document = await makeDocument(owner.id);
  const group = await db.group.create({ data: { name: "Research", ownerId: owner.id } });
  await db.groupMember.createMany({
    data: [
      { groupId: group.id, userId: owner.id, role: "owner" },
      { groupId: group.id, userId: member.id, role: "member" }
    ]
  });

  try {
    const result = await publishForumPost({
      documentId: document.id,
      userId: owner.id,
      audience: { type: "group", groupId: group.id }
    });
    const [saved, grant] = await Promise.all([
      db.document.findUniqueOrThrow({ where: { id: document.id } }),
      db.documentGroupAccess.findUnique({
        where: { documentId_groupId: { documentId: document.id, groupId: group.id } }
      })
    ]);
    assert.ok(result.forumPostedAt);
    assert.ok(saved.forumPostedAt);
    assert.equal(saved.forumPublic, false);
    assert.equal(grant?.permission, "VIEW");
  } finally {
    await db.document.delete({ where: { id: document.id } });
    await db.group.delete({ where: { id: group.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
  }
});

test("publishing publicly does not create a group grant", async () => {
  const owner = await makeUser("owner");
  const document = await makeDocument(owner.id);

  try {
    await publishForumPost({
      documentId: document.id,
      userId: owner.id,
      audience: { type: "public" }
    });
    const saved = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    assert.ok(saved.forumPostedAt);
    assert.equal(saved.forumPublic, true);
    assert.equal(await db.documentGroupAccess.count({ where: { documentId: document.id } }), 0);
  } finally {
    await db.document.delete({ where: { id: document.id } });
    await db.user.delete({ where: { id: owner.id } });
  }
});
