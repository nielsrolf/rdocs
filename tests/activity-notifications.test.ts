import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  notifyDocumentShared,
  notifyForumItemShared,
  resolveForumAudienceUserIds
} from "../lib/activity-notifications";
import { db } from "../lib/db";
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
      slackLinks: { create: { slackTeamId: "T", slackUserId: `U-${crypto.randomUUID()}` } }
    }
  });
}

test("document-share DMs respect the dedicated opt-in", async (t) => {
  const owner = await user("activity-owner");
  const enabled = await user("activity-enabled", { documentShareSlackNotifications: true });
  const disabled = await user("activity-disabled", { documentShareSlackNotifications: false });
  const document = await db.document.create({ data: { title: "Shared research", content: "{}", ownerId: owner.id } });
  t.after(async () => {
    await db.document.delete({ where: { id: document.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, enabled.id, disabled.id] } } });
  });
  const { slack, posted } = fakeSlack();
  const result = await notifyDocumentShared({
    documentId: document.id,
    recipientUserIds: [enabled.id, disabled.id],
    sharedByLabel: owner.name,
    deps: { slack, appUrl: "https://docs.example" }
  });
  assert.equal(result.notified, 1);
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /Shared research/);
});

test("forum notifications for a private post go only to standing-access users", async (t) => {
  const owner = await user("forum-owner");
  const member = await user("forum-member");
  const document = await db.document.create({
    data: {
      title: "Forum research",
      content: "{}",
      ownerId: owner.id,
      forumPostedAt: new Date(),
      memberships: { create: { userId: member.id, permission: "VIEW" } }
    }
  });
  t.after(async () => {
    await db.document.delete({ where: { id: document.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
  });
  const { slack, posted } = fakeSlack();
  const result = await notifyForumItemShared({
    documentId: document.id,
    sharedByLabel: owner.name,
    deps: { slack, appUrl: "https://docs.example" }
  });
  assert.equal(result.notified, 1);
  assert.equal(posted[0].channel.startsWith("U-"), true);
});

test("a new public quick take DMs Slack-linked users in the bot workspace, minus the author and opt-outs", async (t) => {
  const teamId = `T-QT-${crypto.randomUUID()}`;
  const author = await user("qt-author");
  const reader = await user("qt-reader");
  const optedOut = await user("qt-optout", { forumPostSlackNotifications: false });
  for (const u of [author, reader, optedOut]) {
    await db.slackAccountLink.create({
      data: { slackTeamId: teamId, slackUserId: `U-QT-${u.id.slice(-8)}`, userId: u.id }
    });
  }
  const take = await db.document.create({
    data: {
      title: "",
      content: "{}",
      kind: "quicktake",
      quicktakeBody: "a short take about scaling laws",
      ownerId: author.id,
      forumPostedAt: new Date(),
      forumPublic: true
    }
  });
  t.after(async () => {
    await db.document.delete({ where: { id: take.id } });
    await db.user.deleteMany({ where: { id: { in: [author.id, reader.id, optedOut.id] } } });
  });

  const audience = await resolveForumAudienceUserIds(take.id, { slackTeamIds: [teamId] });
  assert.deepEqual(audience.sort(), [reader.id, optedOut.id].sort(), "the author is never in their own audience");

  const { slack, posted } = fakeSlack();
  const result = await notifyForumItemShared({
    documentId: take.id,
    sharedByLabel: author.name,
    deps: { slack, appUrl: "https://docs.example", botTeamId: teamId }
  });
  assert.equal(result.notified, 1, "only the reader who left the default on");
  assert.match(posted[0].text, /posted a quick take/);
  assert.match(posted[0].text, /a short take about scaling laws/);
  assert.match(posted[0].text, /\/forum\/quicktakes\//);
});

test("a user linked in two workspaces is DM'd only in the workspace they picked", async (t) => {
  const teamA = `T-A-${crypto.randomUUID()}`;
  const teamB = `T-B-${crypto.randomUUID()}`;
  const owner = await user("owner-pick");
  const recipient = await db.user.create({
    data: {
      email: `pick-${crypto.randomUUID()}@example.com`,
      name: "pick",
      passwordHash: "x",
      documentShareSlackNotifications: true,
      slackLinks: {
        create: [
          { slackTeamId: teamA, slackUserId: "U-IN-A", createdAt: new Date("2026-01-01") },
          { slackTeamId: teamB, slackUserId: "U-IN-B", createdAt: new Date("2026-02-01") }
        ]
      }
    }
  });
  const doc = await db.document.create({ data: { title: "pick", content: "{}", ownerId: owner.id } });
  t.after(async () => {
    await db.document.delete({ where: { id: doc.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
  });

  // No pick → oldest link (workspace A).
  const first = fakeSlack();
  await notifyDocumentShared({
    documentId: doc.id,
    recipientUserIds: [recipient.id],
    sharedByLabel: "owner",
    deps: { slack: first.slack, appUrl: "https://app.test" }
  });
  assert.deepEqual(first.posted.map((message) => message.channel), ["U-IN-A"]);

  // Picked workspace B → only the B identity is DM'd.
  await db.user.update({ where: { id: recipient.id }, data: { notificationSlackTeamId: teamB } });
  const second = fakeSlack();
  await notifyDocumentShared({
    documentId: doc.id,
    recipientUserIds: [recipient.id],
    sharedByLabel: "owner",
    deps: { slack: second.slack, appUrl: "https://app.test" }
  });
  assert.deepEqual(second.posted.map((message) => message.channel), ["U-IN-B"]);

  // A pick pointing at a workspace the user is no longer linked in falls back to the oldest link.
  await db.user.update({ where: { id: recipient.id }, data: { notificationSlackTeamId: "T-GONE" } });
  const third = fakeSlack();
  await notifyDocumentShared({
    documentId: doc.id,
    recipientUserIds: [recipient.id],
    sharedByLabel: "owner",
    deps: { slack: third.slack, appUrl: "https://app.test" }
  });
  assert.deepEqual(third.posted.map((message) => message.channel), ["U-IN-A"]);
});
