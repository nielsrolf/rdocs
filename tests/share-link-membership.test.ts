import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { ensureShareLinkMembership, resolveDocumentAccess } from "../lib/permissions";

async function makeUser(prefix: string) {
  return db.user.create({
    data: { email: `${prefix}-${crypto.randomUUID()}@example.com`, name: prefix, passwordHash: "x" }
  });
}

async function makeDoc(ownerId: string) {
  return db.document.create({
    data: { title: "Share membership test", content: JSON.stringify({ type: "doc", content: [] }), ownerId }
  });
}

async function makeShareLink(documentId: string, createdById: string, permission: string) {
  return db.shareLink.create({
    data: { documentId, createdById, token: crypto.randomUUID(), permission }
  });
}

test("signed-in share-link visitor is persisted as a collaborator", async (t) => {
  const owner = await makeUser("owner");
  const visitor = await makeUser("visitor");
  const doc = await makeDoc(owner.id);
  const link = await makeShareLink(doc.id, owner.id, "EDIT");
  t.after(async () => {
    await db.document.delete({ where: { id: doc.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, visitor.id] } } });
  });

  const access = await resolveDocumentAccess(doc.id, visitor.id, link.token);
  assert.ok(access);
  assert.equal(access.viaShareLink, true);

  await ensureShareLinkMembership(access, visitor.id);

  const membership = await db.documentMembership.findUnique({
    where: { documentId_userId: { documentId: doc.id, userId: visitor.id } }
  });
  assert.ok(membership, "membership row should exist so the doc shows on the dashboard");
  assert.equal(membership.permission, "EDIT");

  // Subsequent access no longer depends on the share token.
  const later = await resolveDocumentAccess(doc.id, visitor.id, null);
  assert.ok(later);
  assert.equal(later.viaShareLink, false);
  assert.equal(later.permission, "EDIT");

  // Idempotent, and never downgrades an existing membership.
  const viewLink = await makeShareLink(doc.id, owner.id, "VIEW");
  const viewAccess = await resolveDocumentAccess(doc.id, visitor.id, viewLink.token);
  assert.ok(viewAccess);
  await ensureShareLinkMembership(viewAccess, visitor.id);
  const unchanged = await db.documentMembership.findUnique({
    where: { documentId_userId: { documentId: doc.id, userId: visitor.id } }
  });
  assert.equal(unchanged?.permission, "EDIT");
});

test("owner and anonymous visitors get no membership row", async (t) => {
  const owner = await makeUser("owner");
  const doc = await makeDoc(owner.id);
  const link = await makeShareLink(doc.id, owner.id, "COMMENT");
  t.after(async () => {
    await db.document.delete({ where: { id: doc.id } });
    await db.user.delete({ where: { id: owner.id } });
  });

  const ownerAccess = await resolveDocumentAccess(doc.id, owner.id, link.token);
  assert.ok(ownerAccess);
  await ensureShareLinkMembership(ownerAccess, owner.id);

  const anonAccess = await resolveDocumentAccess(doc.id, null, link.token);
  assert.ok(anonAccess);
  await ensureShareLinkMembership(anonAccess, null);

  const memberships = await db.documentMembership.findMany({ where: { documentId: doc.id } });
  assert.equal(memberships.length, 0);
});
