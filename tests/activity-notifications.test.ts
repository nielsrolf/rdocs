import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { notifyDocumentShared, notifyForumItemShared } from "../lib/activity-notifications";
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

test("forum notifications go only to standing-access users who opted in", async (t) => {
  const owner = await user("forum-owner", { forumShareSlackNotifications: true });
  const member = await user("forum-member", { forumShareSlackNotifications: true });
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
