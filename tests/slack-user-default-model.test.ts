import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import {
  ensureSlackChannelDocument,
  startSlackConversationRun
} from "../lib/slack/events";
import type { ConversationRunInput } from "../lib/agent-conversation";
import type { SlackClient } from "../lib/slack/web";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const APP_URL = "http://localhost:14141";

function makeFakeSlack(): SlackClient {
  return {
    async postMessage() {
      return { ts: "1.000" };
    },
    async postEphemeral() {},
    async addReaction() {},
    async removeReaction() {},
    async channelInfo() {
      return { name: "research" };
    },
    async userInfo() {
      return { displayName: "someone" };
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
      return Buffer.from("x");
    },
    async uploadFile() {}
  };
}

async function makeUser(prefix: string, defaults?: { model?: string; effort?: string }) {
  return db.user.create({
    data: {
      email: `${prefix}-${crypto.randomUUID()}@example.com`,
      name: prefix,
      passwordHash: "x",
      defaultAgentModel: defaults?.model ?? null,
      defaultAgentEffort: defaults?.effort ?? null
    }
  });
}

async function startRunFor(input: {
  userId: string;
  document: { id: string; title: string; content: string; agentModel: string | null; agentEffort: string | null; runnerMode: string };
}) {
  const runs: ConversationRunInput[] = [];
  await startSlackConversationRun({
    deps: {
      slack: makeFakeSlack(),
      appUrl: APP_URL,
      botUserId: "UBOT",
      startRun: async (runInput: ConversationRunInput) => {
        runs.push(runInput);
      }
    },
    surface: "mention",
    document: input.document,
    channel: "C123",
    channelName: "research",
    teamId: `T-${crypto.randomUUID()}`,
    triggerId: `trigger-${crypto.randomUUID()}`,
    replyThreadTs: undefined,
    reactionAnchors: [],
    instruction: "hello",
    userId: input.userId,
    slackUserId: "UALICE",
    parentRunId: null,
    channelContext: null
  });
  assert.equal(runs.length, 1);
  return runs[0];
}

test("slack run falls back to the triggering user's default agent config when the channel doc has none", async () => {
  const alice = await makeUser("slack-default-model", { model: "claude-opus-4-8", effort: "high" });
  const document = await ensureSlackChannelDocument({
    slackTeamId: `T-${crypto.randomUUID()}`,
    slackChannelId: "C123",
    channelName: "research",
    userId: alice.id
  });
  assert.equal(document.agentModel, null, "fresh slack channel doc must not pin a model");

  const run = await startRunFor({ userId: alice.id, document });
  assert.deepEqual(run.agentConfig, { model: "claude-opus-4-8", effort: "high" });
});

test("explicit document agent config wins over the user default", async () => {
  const alice = await makeUser("slack-default-model", { model: "claude-opus-4-8", effort: "high" });
  const document = await ensureSlackChannelDocument({
    slackTeamId: `T-${crypto.randomUUID()}`,
    slackChannelId: "C123",
    channelName: "research",
    userId: alice.id
  });
  const pinned = await db.document.update({
    where: { id: document.id },
    data: { agentModel: "claude-fable-5", agentEffort: "low" }
  });

  const run = await startRunFor({ userId: alice.id, document: pinned });
  assert.deepEqual(run.agentConfig, { model: "claude-fable-5", effort: "low" });
});

test("no user default keeps the null config (app default)", async () => {
  const alice = await makeUser("slack-default-model");
  const document = await ensureSlackChannelDocument({
    slackTeamId: `T-${crypto.randomUUID()}`,
    slackChannelId: "C123",
    channelName: "research",
    userId: alice.id
  });

  const run = await startRunFor({ userId: alice.id, document });
  assert.deepEqual(run.agentConfig, { model: null, effort: null });
});
