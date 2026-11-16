import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  countPendingAccessRequests,
  getAccessRequestState,
  getUpgradeRequestState,
  listPendingAccessRequests,
  requestDocumentAccess,
  resolveAccessRequest
} from "../lib/access-requests";
import { notifyAccessGranted, notifyAccessRequested } from "../lib/activity-notifications";
import { db } from "../lib/db";
import { resolveDocumentAccess } from "../lib/permissions";
import type { SlackClient } from "../lib/slack/web";

function fakeSlack() {
  const posted: Array<{ channel: string; text: string; threadTs?: string }> = [];
  const slack = {
    async postMessage(args) { posted.push(args); return { ts: "1", channel: "D1" }; },
    async postEphemeral() {}, async addReaction() {}, async removeReaction() {},
    async channelInfo() { return null; }, async userInfo() { return null; },
    async threadReplies() { return []; }, async channelHistory() { return []; },
    async botChannels() { return []; }, async channelMembers() { return []; },
    async downloadFile() { return null; }, async uploadFile() {}
  } satisfies SlackClient;
  return { slack, posted };
}

async function user(label: string, settings: Record<string, boolean> = {}) {
  return db.user.create({
    data: {
      email: `${label}-${crypto.randomUUID()}@example.com`,
      name: label,
      passwordHash: "x",
      ...settings,
      slackLinks: { create: { slackTeamId: "T", slackUserId: `U-${label}-${crypto.randomUUID()}` } }
    }
  });
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, ownerSettings: Record<string, boolean> = {}) {
  const owner = await user("access-owner", ownerSettings);
  const requester = await user("access-requester");
  const document = await db.document.create({ data: { title: "Private plan", content: "{}", ownerId: owner.id } });
  t.after(async () => {
    await db.document.delete({ where: { id: document.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, requester.id] } } });
  });
  return { owner, requester, document };
}

test("asking for permission opens one request and notifies the owner once", async (t) => {
  const { owner, requester, document } = await fixture(t);
  assert.deepEqual(await getAccessRequestState(document.id, requester.id), { requested: false });

  const first = await requestDocumentAccess({ documentId: document.id, userId: requester.id, message: "  for the\nreview " });
  assert.equal(first.status, "requested");
  assert.equal(first.status === "requested" && first.notifyOwner, true);
  assert.deepEqual(await getAccessRequestState(document.id, requester.id), { requested: true });

  // Asking again neither duplicates the row nor re-notifies.
  const again = await requestDocumentAccess({ documentId: document.id, userId: requester.id });
  assert.equal(again.status === "requested" && again.notifyOwner, false);
  const pending = await listPendingAccessRequests(document.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].message, "for the review");
  assert.equal(pending[0].user.id, requester.id);
  assert.equal(await countPendingAccessRequests(document.id), 1);

  const { slack, posted } = fakeSlack();
  const result = await notifyAccessRequested({
    documentId: document.id,
    requester: { name: requester.name, email: requester.email },
    message: "for <!channel> the review",
    deps: { slack, appUrl: "https://docs.example" }
  });
  assert.equal(result.notified, 1);
  const ownerLink = await db.slackAccountLink.findFirstOrThrow({ where: { userId: owner.id } });
  assert.equal(posted[0].channel, ownerLink.slackUserId);
  assert.match(posted[0].text, /access-requester/);
  assert.match(posted[0].text, new RegExp(`/documents/${document.id}\\?access=requests\\|Private plan>`));
  assert.ok(!posted[0].text.includes("<!channel>"), "requester text is escaped");
});

test("an owner who turned access-request DMs off is not notified", async (t) => {
  const { requester, document } = await fixture(t, { accessRequestSlackNotifications: false });
  const { slack, posted } = fakeSlack();
  const result = await notifyAccessRequested({
    documentId: document.id,
    requester: { name: requester.name, email: requester.email },
    deps: { slack, appUrl: "https://docs.example" }
  });
  assert.equal(result.notified, 0);
  assert.equal(posted.length, 0);
});

test("granting a request gives the requester access and tells them", async (t) => {
  const { owner, requester, document } = await fixture(t);
  const outcome = await requestDocumentAccess({ documentId: document.id, userId: requester.id });
  assert.equal(outcome.status, "requested");
  const requestId = outcome.status === "requested" ? outcome.requestId : "";

  // A request id from another document does not resolve here.
  assert.deepEqual(
    await resolveAccessRequest({ documentId: "other-doc", requestId, action: "grant", permission: "EDIT" }),
    { status: "not-found" }
  );
  assert.equal(await resolveDocumentAccess(document.id, requester.id), null);

  const resolution = await resolveAccessRequest({
    documentId: document.id,
    requestId,
    action: "grant",
    permission: "COMMENT"
  });
  assert.equal(resolution.status, "granted");
  assert.equal(resolution.status === "granted" && resolution.membership.user.id, requester.id);
  assert.equal((await resolveDocumentAccess(document.id, requester.id))?.permission, "COMMENT");
  assert.equal(await countPendingAccessRequests(document.id), 0);
  assert.deepEqual(await requestDocumentAccess({ documentId: document.id, userId: requester.id }), {
    status: "has-access"
  });
  // Already resolved: a second decision is refused.
  assert.deepEqual(await resolveAccessRequest({ documentId: document.id, requestId, action: "decline" }), {
    status: "not-found"
  });

  const { slack, posted } = fakeSlack();
  const result = await notifyAccessGranted({
    documentId: document.id,
    requesterUserId: requester.id,
    grantedByLabel: owner.name,
    deps: { slack, appUrl: "https://docs.example" }
  });
  assert.equal(result.notified, 1);
  assert.match(posted[0].text, /access-owner.*gave you access.*Private plan/);

  // Access removed later: the user may ask again, and the owner hears about it.
  await db.documentMembership.deleteMany({ where: { documentId: document.id, userId: requester.id } });
  const reopened = await requestDocumentAccess({ documentId: document.id, userId: requester.id });
  assert.equal(reopened.status === "requested" && reopened.notifyOwner, true);
  assert.equal(await countPendingAccessRequests(document.id), 1);
});

test("a declined request stays declined: no access, no second notification, not disclosed", async (t) => {
  const { requester, document } = await fixture(t);
  const outcome = await requestDocumentAccess({ documentId: document.id, userId: requester.id });
  const requestId = outcome.status === "requested" ? outcome.requestId : "";
  assert.deepEqual(await resolveAccessRequest({ documentId: document.id, requestId, action: "decline" }), {
    status: "declined"
  });
  assert.equal(await resolveDocumentAccess(document.id, requester.id), null);
  assert.equal(await countPendingAccessRequests(document.id), 0);
  assert.deepEqual(await getAccessRequestState(document.id, requester.id), { requested: true });
  const again = await requestDocumentAccess({ documentId: document.id, userId: requester.id });
  assert.equal(again.status === "requested" && again.notifyOwner, false);
  assert.equal(await countPendingAccessRequests(document.id), 0);
});

test("there is nothing to ask for on a missing document or a quick take", async (t) => {
  const { owner, requester } = await fixture(t);
  const quicktake = await db.document.create({
    data: { title: "", content: "{}", kind: "quicktake", quicktakeBody: "hi", ownerId: owner.id }
  });
  t.after(async () => {
    await db.document.deleteMany({ where: { id: quicktake.id } });
  });
  assert.equal(await getAccessRequestState("no-such-document", requester.id), null);
  assert.equal(await getAccessRequestState(quicktake.id, requester.id), null);
  assert.deepEqual(await requestDocumentAccess({ documentId: "no-such-document", userId: requester.id }), {
    status: "not-found"
  });
  assert.deepEqual(await requestDocumentAccess({ documentId: quicktake.id, userId: requester.id }), {
    status: "not-found"
  });
});

test("someone with view access can ask for comment or edit access", async (t) => {
  const { owner, requester, document } = await fixture(t);
  await db.documentMembership.create({
    data: { documentId: document.id, userId: requester.id, permission: "VIEW" }
  });

  // Asking for what you already have (or less) is not a request.
  assert.deepEqual(await requestDocumentAccess({ documentId: document.id, userId: requester.id }), { status: "has-access" });
  assert.deepEqual(
    await requestDocumentAccess({ documentId: document.id, userId: requester.id, permission: "VIEW" }),
    { status: "has-access" }
  );
  assert.deepEqual(await getUpgradeRequestState(document.id, requester.id, "VIEW"), { requestedPermission: null });

  const asked = await requestDocumentAccess({
    documentId: document.id,
    userId: requester.id,
    permission: "EDIT",
    message: "need to fix typos"
  });
  assert.equal(asked.status, "requested");
  assert.equal(asked.status === "requested" && asked.notifyOwner, true);
  assert.equal(asked.status === "requested" && asked.currentPermission, "VIEW");
  assert.deepEqual(await getUpgradeRequestState(document.id, requester.id, "VIEW"), { requestedPermission: "EDIT" });

  // The owner sees it although the requester is already a member.
  const pending = await listPendingAccessRequests(document.id);
  assert.deepEqual(
    pending.map((r) => [r.user.id, r.requestedPermission, r.currentPermission, r.message]),
    [[requester.id, "EDIT", "VIEW", "need to fix typos"]]
  );
  assert.equal(await countPendingAccessRequests(document.id), 1);

  // Asking again does not re-notify.
  const again = await requestDocumentAccess({ documentId: document.id, userId: requester.id, permission: "EDIT" });
  assert.equal(again.status === "requested" && again.notifyOwner, false);

  const { slack, posted } = fakeSlack();
  await notifyAccessRequested({
    documentId: document.id,
    requester: { name: requester.name, email: requester.email },
    permission: "EDIT",
    currentPermission: "VIEW",
    deps: { slack, appUrl: "https://docs.example" }
  });
  assert.match(posted[0].text, /has view access.*asking for edit access/);

  // Granting without choosing a level gives what was asked for.
  const requestId = asked.status === "requested" ? asked.requestId : "";
  const resolution = await resolveAccessRequest({ documentId: document.id, requestId, action: "grant" });
  assert.equal(resolution.status === "granted" && resolution.membership.permission, "EDIT");
  assert.equal((await resolveDocumentAccess(document.id, requester.id))?.permission, "EDIT");
  assert.equal(await countPendingAccessRequests(document.id), 0);
  assert.deepEqual(
    await requestDocumentAccess({ documentId: document.id, userId: requester.id, permission: "EDIT" }),
    { status: "has-access" }
  );
  void owner;
});

test("upgrade requests: a partial grant can be followed by a new ask; a decline is final and keeps the access", async (t) => {
  const { requester, document } = await fixture(t);
  await db.documentMembership.create({
    data: { documentId: document.id, userId: requester.id, permission: "VIEW" }
  });
  const first = await requestDocumentAccess({ documentId: document.id, userId: requester.id, permission: "EDIT" });
  const firstId = first.status === "requested" ? first.requestId : "";
  // The owner gives less than asked.
  await resolveAccessRequest({ documentId: document.id, requestId: firstId, action: "grant", permission: "COMMENT" });
  assert.equal((await resolveDocumentAccess(document.id, requester.id))?.permission, "COMMENT");
  assert.deepEqual(await getUpgradeRequestState(document.id, requester.id, "COMMENT"), { requestedPermission: null });

  const second = await requestDocumentAccess({ documentId: document.id, userId: requester.id, permission: "EDIT" });
  assert.equal(second.status === "requested" && second.notifyOwner, true);
  const secondId = second.status === "requested" ? second.requestId : "";
  assert.deepEqual(await resolveAccessRequest({ documentId: document.id, requestId: secondId, action: "decline" }), {
    status: "declined"
  });
  // Declined: the comment access stays, the requester still sees "asked", the owner is not asked again.
  assert.equal((await resolveDocumentAccess(document.id, requester.id))?.permission, "COMMENT");
  assert.deepEqual(await getUpgradeRequestState(document.id, requester.id, "COMMENT"), { requestedPermission: "EDIT" });
  const third = await requestDocumentAccess({ documentId: document.id, userId: requester.id, permission: "EDIT" });
  assert.equal(third.status === "requested" && third.notifyOwner, false);
  assert.equal(await countPendingAccessRequests(document.id), 0);
});

test("a request for access that was declined does not block a later upgrade request", async (t) => {
  const { requester, document } = await fixture(t);
  const first = await requestDocumentAccess({ documentId: document.id, userId: requester.id });
  const firstId = first.status === "requested" ? first.requestId : "";
  await resolveAccessRequest({ documentId: document.id, requestId: firstId, action: "decline" });
  // Shared with them some other way later; now they want more.
  await db.documentMembership.create({
    data: { documentId: document.id, userId: requester.id, permission: "VIEW" }
  });
  const upgrade = await requestDocumentAccess({ documentId: document.id, userId: requester.id, permission: "COMMENT" });
  assert.equal(upgrade.status === "requested" && upgrade.notifyOwner, true);
  assert.deepEqual(
    (await listPendingAccessRequests(document.id)).map((r) => [r.requestedPermission, r.currentPermission]),
    [["COMMENT", "VIEW"]]
  );
});
