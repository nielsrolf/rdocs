import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { checkIntegrationPassword, createIntegrationAccount } from "../lib/integration-accounts";
import {
  addIntegrationGroupMember,
  createIntegrationGroup,
  getIntegrationGroup,
  groupsForUser,
  integrationApiToken,
  isIntegrationRequest
} from "../lib/integration-groups";

process.env.INTEGRATION_SIGNIN_SECRET = "test-secret";
// Never send real verification mail from tests.
delete process.env.RESEND_API_KEY;

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

test("integration groups: create with owner as member, add members idempotently", async () => {
  const mk = (tag: string) =>
    db.user.create({ data: { email: `igc-${tag}-${crypto.randomUUID()}@example.com`, name: tag, passwordHash: "x" } });
  const [owner, friend] = await Promise.all([mk("owner"), mk("friend")]);
  const group = await createIntegrationGroup("Forecasting 2027", owner.id);
  try {
    assert.ok(group);
    assert.deepEqual(group.members.map((m) => [m.userId, m.role]), [[owner.id, "owner"]]);
    assert.equal(await createIntegrationGroup("x", "no-such-user"), null);
    await addIntegrationGroupMember(group.id, friend.id);
    const again = await addIntegrationGroupMember(group.id, friend.id);
    assert.deepEqual(again!.members.map((m) => m.userId), [owner.id, friend.id]);
    assert.equal(await addIntegrationGroupMember(group.id, "no-such-user"), null);
    assert.equal(await addIntegrationGroupMember("no-such-group", friend.id), null);
    assert.equal((await getIntegrationGroup(group.id))!.members.length, 2);
    assert.deepEqual((await groupsForUser(friend.id)).map((g) => g.id), [group.id]);
  } finally {
    await db.group.deleteMany({ where: { id: group?.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, friend.id] } } });
  }
});

test("integration accounts: sign up, refuse a taken email, check passwords", async () => {
  const email = `ia-${crypto.randomUUID()}@Example.com`;
  try {
    const created = await createIntegrationAccount({ name: "Ada", email, password: "correct horse" });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.user.email, email.toLowerCase());
    assert.equal(created.user.emailVerificationPending, false); // no mail transport in tests
    const dup = await createIntegrationAccount({ name: "Eve", email, password: "another one" });
    assert.deepEqual(dup.ok ? null : dup.status, 409);
    const good = await checkIntegrationPassword(email.toUpperCase(), "correct horse");
    assert.equal(good.ok && good.user.id, created.user.id);
    const bad = await checkIntegrationPassword(email, "wrong password");
    assert.equal(bad.ok ? 200 : bad.status, 401);
    await db.user.update({ where: { id: created.user.id }, data: { emailVerificationPending: true } });
    const pending = await checkIntegrationPassword(email, "correct horse");
    assert.equal(pending.ok ? 200 : pending.status, 403);
    // an unconfirmed account can be claimed again, keeping its id
    const reclaimed = await createIntegrationAccount({ name: "Ada L", email, password: "new password" });
    assert.equal(reclaimed.ok && reclaimed.user.id, created.user.id);
  } finally {
    await db.user.deleteMany({ where: { email: email.toLowerCase() } });
  }
});
