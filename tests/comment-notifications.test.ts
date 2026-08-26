import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  notifyCommentPosted,
  resolveCommentNotificationRecipients
} from "../lib/comment-notifications";
import { db } from "../lib/db";
import { handleSlackDirectMessage } from "../lib/slack/events";
import type { ConversationRunInput } from "../lib/agent-conversation";
import type { SlackClient } from "../lib/slack/web";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const BOT_USER_ID = "UBOT";
const APP_URL = "http://localhost:14141";

// Fake Slack client whose postMessage resolves the IM channel the way the real
// chat.postMessage does: posting to a U… user id returns the D… IM channel.
function makeFakeSlack() {
  const posted: Array<{ channel: string; text: string; threadTs?: string }> = [];
  const reactions: Array<{ op: "add" | "remove"; ts: string; name: string }> = [];
  const client: SlackClient = {
    async postMessage(args) {
      posted.push(args);
      return {
        ts: `${posted.length}.000`,
        channel: args.channel.startsWith("U") ? `D${args.channel.slice(1)}` : args.channel
      };
    },
    async postEphemeral() {},
    async addReaction({ ts, name }) {
      reactions.push({ op: "add", ts, name });
    },
    async removeReaction({ ts, name }) {
      reactions.push({ op: "remove", ts, name });
    },
    async channelInfo() {
      return { name: "research" };
    },
    async userInfo(userId) {
      return { displayName: `name-of-${userId}` };
    },
    async threadReplies() {
      return [];
    },
    async channelHistory() {
      return [];
    },
    async botChannels() {
      return [];
    },
    async channelMembers() {
      return [];
    },
    async downloadFile() {
      return Buffer.from("fake-bytes");
    },
    async uploadFile() {}
  };
  return { client, posted, reactions };
}

async function makeUser(prefix: string, overrides?: { commentSlackNotifications?: boolean }) {
  return db.user.create({
    data: {
      email: `${prefix}-${crypto.randomUUID()}@example.com`,
      name: prefix,
      passwordHash: "x",
      ...(overrides ?? {})
    }
  });
}

function notifierDeps(client: SlackClient) {
  return { slack: client, appUrl: APP_URL, botUserId: BOT_USER_ID };
}

test("recipients: owner + members + group members with a Slack link, minus author/opt-outs/unlinked", async (t) => {
  const teamId = `T-${crypto.randomUUID()}`;
  const owner = await makeUser("cn-owner");
  const author = await makeUser("cn-author"); // excluded: wrote the comment
  const member = await makeUser("cn-member");
  const optedOut = await makeUser("cn-optout", { commentSlackNotifications: false });
  const unlinked = await makeUser("cn-unlinked"); // no Slack link
  const groupMember = await makeUser("cn-group-member");

  const group = await db.group.create({
    data: {
      name: `cn-group-${crypto.randomUUID()}`,
      ownerId: groupMember.id
    }
  });
  const document = await db.document.create({
    data: {
      title: "notify-recipients-doc",
      content: "{}",
      ownerId: owner.id,
      memberships: {
        create: [
          { userId: author.id, permission: "EDIT" },
          { userId: member.id, permission: "VIEW" },
          { userId: optedOut.id, permission: "EDIT" },
          { userId: unlinked.id, permission: "EDIT" }
        ]
      },
      groupAccess: { create: { groupId: group.id, permission: "VIEW" } }
    }
  });
  for (const [i, user] of [owner, author, member, optedOut, groupMember].entries()) {
    await db.slackAccountLink.create({
      data: { slackTeamId: teamId, slackUserId: `U-CN-${i}-${user.id.slice(-6)}`, userId: user.id }
    });
  }
  t.after(async () => {
    await db.document.delete({ where: { id: document.id } });
    await db.group.delete({ where: { id: group.id } });
    for (const user of [owner, author, member, optedOut, unlinked, groupMember]) {
      await db.user.delete({ where: { id: user.id } });
    }
  });

  const recipients = await resolveCommentNotificationRecipients({
    documentId: document.id,
    excludeUserIds: [author.id, null, undefined]
  });
  const ids = recipients.map((r) => r.userId).sort();
  assert.deepEqual(ids, [owner.id, member.id, groupMember.id].sort());
  for (const recipient of recipients) {
    assert.equal(recipient.slackTeamId, teamId);
    assert.match(recipient.slackUserId, /^U-CN-/);
  }
});

test("recipients: per-document comment preferences override the global default", async (t) => {
  const owner = await makeUser("cn-pref-owner");
  const globallyOff = await makeUser("cn-pref-enable", { commentSlackNotifications: false });
  const globallyOn = await makeUser("cn-pref-disable", { commentSlackNotifications: true });
  const document = await db.document.create({
    data: {
      title: "notification preferences",
      content: "{}",
      ownerId: owner.id,
      memberships: {
        create: [
          { userId: globallyOff.id, permission: "VIEW" },
          { userId: globallyOn.id, permission: "VIEW" }
        ]
      },
      notificationPreferences: {
        create: [
          { userId: globallyOff.id, commentSlackNotifications: true },
          { userId: globallyOn.id, commentSlackNotifications: false }
        ]
      }
    }
  });
  for (const user of [globallyOff, globallyOn]) {
    await db.slackAccountLink.create({
      data: { slackTeamId: "T-pref", slackUserId: `U-${user.id}`, userId: user.id }
    });
  }
  t.after(async () => {
    await db.document.delete({ where: { id: document.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, globallyOff.id, globallyOn.id] } } });
  });

  const recipients = await resolveCommentNotificationRecipients({ documentId: document.id });
  assert.deepEqual(recipients.map((recipient) => recipient.userId), [globallyOff.id]);
});

test("notify: first comment posts a root DM + persists the row; the next threads under it", async (t) => {
  const teamId = `T-${crypto.randomUUID()}`;
  const owner = await makeUser("cn-dm-owner");
  const author = await makeUser("cn-dm-author");
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "U-CN-DM-OWNER", userId: owner.id }
  });
  const document = await db.document.create({
    data: {
      title: "notify-dm-doc",
      content: "{}",
      ownerId: owner.id,
      memberships: { create: { userId: author.id, permission: "EDIT" } }
    }
  });
  const thread = await db.commentThread.create({
    data: {
      documentId: document.id,
      createdById: author.id,
      anchorText: "the anchored sentence",
      comments: { create: { body: "first comment", authorId: author.id } }
    }
  });
  t.after(async () => {
    await db.document.delete({ where: { id: document.id } });
    await db.user.delete({ where: { id: owner.id } });
    await db.user.delete({ where: { id: author.id } });
  });

  const { client, posted } = makeFakeSlack();
  const first = await notifyCommentPosted({
    threadId: thread.id,
    documentId: document.id,
    commentBody: "first comment",
    authorLabel: "Author",
    excludeUserIds: [author.id],
    deps: notifierDeps(client)
  });
  assert.equal(first.notified, 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].channel, "U-CN-DM-OWNER");
  assert.equal(posted[0].threadTs, undefined);
  assert.match(posted[0].text, /commented on/);
  assert.match(posted[0].text, /first comment/);
  assert.match(posted[0].text, new RegExp(`<@${BOT_USER_ID}>`));

  const row = await db.slackCommentNotification.findUnique({
    where: { threadId_userId: { threadId: thread.id, userId: owner.id } }
  });
  assert.ok(row, "root notification row must be persisted");
  assert.equal(row!.slackChannelId, "D-CN-DM-OWNER");
  assert.equal(row!.messageTs, "1.000");

  const second = await notifyCommentPosted({
    threadId: thread.id,
    documentId: document.id,
    commentBody: "a follow-up reply",
    authorLabel: "Author",
    excludeUserIds: [author.id],
    deps: notifierDeps(client)
  });
  assert.equal(second.notified, 1);
  assert.equal(posted.length, 2);
  // Threaded under the persisted root, in the resolved IM channel.
  assert.equal(posted[1].channel, "D-CN-DM-OWNER");
  assert.equal(posted[1].threadTs, "1.000");
  assert.match(posted[1].text, /a follow-up reply/);
  const rows = await db.slackCommentNotification.findMany({
    where: { threadId: thread.id }
  });
  assert.equal(rows.length, 1, "no second row for the same thread+recipient");
});

test("DM reply in a notification thread posts a comment as the user; @bot also starts Ask-AI", async (t) => {
  const teamId = `T-${crypto.randomUUID()}`;
  const owner = await makeUser("cn-reply-owner");
  const replier = await makeUser("cn-replier");
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "U-CN-REPLIER", userId: replier.id }
  });
  const document = await db.document.create({
    data: {
      title: "notify-reply-doc",
      content: "{}",
      ownerId: owner.id,
      memberships: { create: { userId: replier.id, permission: "EDIT" } }
    }
  });
  const thread = await db.commentThread.create({
    data: {
      documentId: document.id,
      createdById: owner.id,
      anchorText: "anchored",
      comments: { create: { body: "root comment", authorId: owner.id } }
    }
  });
  const imChannel = "D-CN-REPLIER";
  const rootTs = "100.000";
  await db.slackCommentNotification.create({
    data: {
      slackTeamId: teamId,
      slackChannelId: imChannel,
      messageTs: rootTs,
      threadId: thread.id,
      documentId: document.id,
      userId: replier.id
    }
  });
  t.after(async () => {
    await db.document.delete({ where: { id: document.id } });
    await db.user.delete({ where: { id: owner.id } });
    await db.user.delete({ where: { id: replier.id } });
  });

  const { client, reactions } = makeFakeSlack();
  const runs: ConversationRunInput[] = [];
  const askAiCalls: Array<{ threadId: string; userId: string; agentAccessMode: string }> = [];
  const deps = {
    slack: client,
    appUrl: APP_URL,
    botUserId: BOT_USER_ID,
    startRun: async (input: ConversationRunInput) => {
      runs.push(input);
    },
    startAskAi: async (input: { threadId: string; userId: string; agentAccessMode: "workspace" | "read_only" }) => {
      askAiCalls.push(input);
      return "fake-ai-run-id";
    }
  };
  const dmReply = (text: string, ts: string) => ({
    eventId: `ev-${crypto.randomUUID()}`,
    teamId,
    channel: imChannel,
    user: "U-CN-REPLIER",
    text,
    ts,
    threadTs: rootTs
  });

  // Plain reply → comment as the user, NO agent run of any kind.
  const plain = await handleSlackDirectMessage(dmReply("sounds good, shipping it", "101.000"), deps);
  assert.equal(plain.handled, true);
  assert.equal("action" in plain && plain.action, "comment-reply");
  assert.equal(runs.length, 0, "no conversation run for a notification reply");
  assert.equal(askAiCalls.length, 0);
  const comments = await db.comment.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: "asc" }
  });
  assert.equal(comments.length, 2);
  assert.equal(comments[1].body, "sounds good, shipping it");
  assert.equal(comments[1].authorId, replier.id);
  assert.ok(
    reactions.some((r) => r.op === "add" && r.ts === "101.000" && r.name === "speech_balloon"),
    "plain reply gets the speech_balloon ack"
  );

  // Mentioning the bot → comment AND an Ask-AI run for the doc thread.
  const withBot = await handleSlackDirectMessage(
    dmReply(`<@${BOT_USER_ID}> can you double-check this?`, "102.000"),
    deps
  );
  assert.equal(withBot.handled, true);
  assert.equal("action" in withBot && withBot.action, "comment-reply-ask-ai");
  assert.equal(runs.length, 0, "ask-ai goes through startAskAi, not the conversation runner");
  assert.equal(askAiCalls.length, 1);
  assert.equal(askAiCalls[0].threadId, thread.id);
  assert.equal(askAiCalls[0].userId, replier.id);
  const afterBot = await db.comment.findMany({ where: { threadId: thread.id } });
  assert.equal(afterBot.length, 3, "the stripped reply text is still posted as a comment");
  assert.ok(
    reactions.some((r) => r.op === "add" && r.ts === "102.000" && r.name === "eyes"),
    "ask-ai reply gets the eyes ack"
  );

  // A threaded DM reply that does NOT match a notification stays on the normal
  // agent conversation path.
  const other = await handleSlackDirectMessage(
    { ...dmReply("unrelated question", "103.000"), threadTs: "999.000" },
    deps
  );
  assert.equal(other.handled, true);
  assert.equal(runs.length, 1, "non-notification DM threads still start agent runs");
  const dmDoc = await db.document.findUnique({
    where: { slackTeamId_slackChannelId: { slackTeamId: teamId, slackChannelId: imChannel } }
  });
  if (dmDoc) {
    await db.document.delete({ where: { id: dmDoc.id } });
  }
});
