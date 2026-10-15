import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { groupsForUser, integrationApiToken, isIntegrationRequest } from "../lib/integration-groups";

process.env.INTEGRATION_SIGNIN_SECRET = "test-secret";

test("integration API token is derived from the sign-in secret and checked exactly", () => {
  const token = integrationApiToken()!;
  assert.equal(token, crypto.createHash("sha256").update("rdocs-integration-api:test-secret").digest("hex"));
  assert.equal(isIntegrationRequest(`Bearer ${token}`), true);
  assert.equal(isIntegrationRequest(`Bearer ${token}x`), false);
  assert.equal(isIntegrationRequest("Bearer test-secret"), false);
  assert.equal(isIntegrationRequest(null), false);
});

test("groupsForUser lists owned and joined groups with all members, owner included", async () => {
  const mk = (tag: string) =>
    db.user.create({ data: { email: `ig-${tag}-${crypto.randomUUID()}@example.com`, name: tag, passwordHash: "x" } });
  const [owner, member, outsider] = await Promise.all([mk("owner"), mk("member"), mk("outsider")]);
  const group = await db.group.create({ data: { name: "Team", ownerId: owner.id } });
  await db.groupMember.create({ data: { groupId: group.id, userId: member.id } });
  try {
    const forMember = await groupsForUser(member.id);
    assert.deepEqual(forMember.map((g) => g.name), ["Team"]);
    assert.deepEqual(forMember[0].members.map((m) => m.userId).sort(), [owner.id, member.id].sort());
    assert.equal((await groupsForUser(owner.id)).length, 1);
    assert.equal((await groupsForUser(outsider.id)).length, 0);
  } finally {
    await db.group.delete({ where: { id: group.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, member.id, outsider.id] } } });
  }
});
