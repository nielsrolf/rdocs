import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { listFrequentCollaborators } from "../lib/collaborator-suggestions";
import { db } from "../lib/db";

async function user(label: string) {
  return db.user.create({
    data: { email: `${label}-${crypto.randomUUID()}@example.com`, name: label, passwordHash: "x" }
  });
}

test("frequent collaborators are ranked by shared-document count", async (t) => {
  const me = await user("suggest-me");
  const frequent = await user("suggest-frequent");
  const occasional = await user("suggest-occasional");
  const documents = await Promise.all([
    db.document.create({
      data: {
        title: "one",
        content: "{}",
        ownerId: me.id,
        memberships: { create: [{ userId: frequent.id, permission: "EDIT" }, { userId: occasional.id, permission: "VIEW" }] }
      }
    }),
    db.document.create({
      data: {
        title: "two",
        content: "{}",
        ownerId: me.id,
        memberships: { create: { userId: frequent.id, permission: "COMMENT" } }
      }
    })
  ]);
  t.after(async () => {
    await db.document.deleteMany({ where: { id: { in: documents.map((document) => document.id) } } });
    await db.user.deleteMany({ where: { id: { in: [me.id, frequent.id, occasional.id] } } });
  });

  const suggestions = await listFrequentCollaborators(me.id);
  assert.equal(suggestions[0]?.id, frequent.id);
  assert.equal(suggestions[0]?.count, 2);
  assert.equal(suggestions[1]?.id, occasional.id);
  assert.equal(suggestions[1]?.count, 1);
});
