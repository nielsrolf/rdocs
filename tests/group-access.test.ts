import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { resolveDocumentAccess } from "../lib/permissions";
import { listAccessibleDocumentsForUser } from "../lib/document-data";
import { listForumDocumentsForUser } from "../lib/forum-data";

// Groups grant document access through resolveDocumentAccess — the single
// gate every route uses — so group-shared docs behave exactly like direct
// memberships everywhere (studio, forum, MCP, agent runs).

async function makeUser(tag: string) {
  return db.user.create({
    data: { email: `grp-${tag}-${crypto.randomUUID()}@example.com`, name: tag, passwordHash: "x" }
  });
}

async function makeDocument(ownerId: string, extra: Record<string, unknown> = {}) {
  return db.document.create({
    data: { ownerId, title: "Group doc", content: "{}", ...extra }
  });
}

async function cleanup(documentIds: string[], userIds: string[], groupIds: string[]) {
  await db.document.deleteMany({ where: { id: { in: documentIds } } });
  await db.group.deleteMany({ where: { id: { in: groupIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

test("group membership grants document access at the granted permission", async () => {
  const owner = await makeUser("owner");
  const member = await makeUser("member");
  const outsider = await makeUser("outsider");
  const doc = await makeDocument(owner.id);
  const group = await db.group.create({ data: { name: "Team", ownerId: owner.id } });
  await db.groupMember.create({ data: { groupId: group.id, userId: member.id } });
  await db.documentGroupAccess.create({
    data: { documentId: doc.id, groupId: group.id, permission: "COMMENT" }
  });

  try {
    const access = await resolveDocumentAccess(doc.id, member.id);
    assert.ok(access, "group member should get access");
    assert.equal(access?.permission, "COMMENT");
    assert.equal(access?.viaShareLink, false);

    const none = await resolveDocumentAccess(doc.id, outsider.id);
    assert.equal(none, null, "non-member gets no access");
  } finally {
    await cleanup([doc.id], [owner.id, member.id, outsider.id], [group.id]);
  }
});

test("strongest permission wins across direct membership and multiple groups", async () => {
  const owner = await makeUser("owner");
  const member = await makeUser("member");
  const doc = await makeDocument(owner.id);
  const viewGroup = await db.group.create({ data: { name: "Viewers", ownerId: owner.id } });
  const editGroup = await db.group.create({ data: { name: "Editors", ownerId: owner.id } });
  await db.groupMember.createMany({
    data: [
      { groupId: viewGroup.id, userId: member.id },
      { groupId: editGroup.id, userId: member.id }
    ]
  });
  await db.documentGroupAccess.createMany({
    data: [
      { documentId: doc.id, groupId: viewGroup.id, permission: "VIEW" },
      { documentId: doc.id, groupId: editGroup.id, permission: "EDIT" }
    ]
  });
  // Direct membership weaker than the strongest group grant.
  await db.documentMembership.create({
    data: { documentId: doc.id, userId: member.id, permission: "VIEW" }
  });

  try {
    const access = await resolveDocumentAccess(doc.id, member.id);
    assert.equal(access?.permission, "EDIT");
  } finally {
    await cleanup([doc.id], [owner.id, member.id], [viewGroup.id, editGroup.id]);
  }
});

test("dashboard listing includes group-shared documents exactly once", async () => {
  const owner = await makeUser("owner");
  const member = await makeUser("member");
  const doc = await makeDocument(owner.id);
  const group = await db.group.create({ data: { name: "Team", ownerId: owner.id } });
  await db.groupMember.create({ data: { groupId: group.id, userId: member.id } });
  await db.documentGroupAccess.create({
    data: { documentId: doc.id, groupId: group.id, permission: "VIEW" }
  });
  // Also a direct membership — the doc must not be listed twice.
  await db.documentMembership.create({
    data: { documentId: doc.id, userId: member.id, permission: "COMMENT" }
  });

  try {
    const docs = await listAccessibleDocumentsForUser(member.id);
    const hits = docs.filter((d) => d.id === doc.id);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].permission, "COMMENT", "direct membership permission preferred when stronger");
  } finally {
    await cleanup([doc.id], [owner.id, member.id], [group.id]);
  }
});

test("forum frontpage lists only accessible posted docs, with score and own vote", async () => {
  const owner = await makeUser("owner");
  const member = await makeUser("member");
  const posted = await makeDocument(owner.id, { forumPostedAt: new Date(), title: "Posted" });
  const unposted = await makeDocument(owner.id, { title: "Unposted" });
  const foreign = await makeUser("foreign");
  const foreignPosted = await makeDocument(foreign.id, { forumPostedAt: new Date(), title: "Foreign" });
  const group = await db.group.create({ data: { name: "Team", ownerId: owner.id } });
  await db.groupMember.create({ data: { groupId: group.id, userId: member.id } });
  await db.documentGroupAccess.createMany({
    data: [
      { documentId: posted.id, groupId: group.id, permission: "VIEW" },
      { documentId: unposted.id, groupId: group.id, permission: "VIEW" }
    ]
  });
  await db.documentVote.createMany({
    data: [
      { documentId: posted.id, userId: owner.id, value: 1 },
      { documentId: posted.id, userId: member.id, value: 1 }
    ]
  });

  try {
    const forum = await listForumDocumentsForUser(member.id);
    const ids = forum.map((d) => d.id);
    assert.ok(ids.includes(posted.id), "accessible posted doc listed");
    assert.ok(!ids.includes(unposted.id), "accessible but unposted doc not listed");
    assert.ok(!ids.includes(foreignPosted.id), "posted but inaccessible doc not listed");
    const entry = forum.find((d) => d.id === posted.id);
    assert.equal(entry?.score, 2);
    assert.equal(entry?.ownVote, 1);
  } finally {
    await cleanup(
      [posted.id, unposted.id, foreignPosted.id],
      [owner.id, member.id, foreign.id],
      [group.id]
    );
  }
});
