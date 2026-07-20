import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { computeNextRunAt, fireScheduledTask, schedulerTick, MIN_RECURRENCE_MS } from "../lib/scheduler";
import { handleSlackAgentToolCall } from "../lib/slack/agent-tools";
import type { ConversationRunInput } from "../lib/agent-conversation";
import type { SlackEventDeps } from "../lib/slack/events";
import type { SlackClient } from "../lib/slack/web";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const BOT = "UBOT";

function makeDeps(runs: ConversationRunInput[]) {
  const posted: Array<{ channel: string; text: string; threadTs?: string }> = [];
  const slack: SlackClient = {
    async postMessage(args) {
      posted.push(args);
      return { ts: `${9000 + posted.length}.000` };
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
      return [BOT, "UALICE"];
    }
  };
  const deps: SlackEventDeps = {
    slack,
    appUrl: "http://localhost:14141",
    botUserId: BOT,
    startRun: async (input) => {
      runs.push(input);
    }
  };
  return { deps, slack, posted };
}

async function makeLinkedUser(teamId: string, slackUserId: string, name: string) {
  const user = await db.user.create({
    data: { email: `${name}-${crypto.randomUUID()}@example.com`, name, passwordHash: "x" }
  });
  await db.slackAccountLink.create({ data: { slackTeamId: teamId, slackUserId, userId: user.id } });
  return user;
}

test("computeNextRunAt: cron, one-shot, guards", () => {
  const from = new Date("2026-07-20T10:00:00Z");
  const next = computeNextRunAt({ cron: "0 9 * * *", timezone: "UTC", from });
  assert.equal(next.toISOString(), "2026-07-21T09:00:00.000Z");

  const oneShot = computeNextRunAt({ at: "2026-07-21T09:00:00Z", from });
  assert.equal(oneShot.toISOString(), "2026-07-21T09:00:00.000Z");

  assert.throws(() => computeNextRunAt({ cron: "* * * * *", from }), /at least 5 minutes/);
  assert.throws(() => computeNextRunAt({ at: "2020-01-01T00:00:00Z", from }), /in the past/);
  assert.throws(() => computeNextRunAt({ from }), /cron .*or at/i);
  assert.throws(() => computeNextRunAt({ cron: "0 9 * * *", at: "2026-07-21T09:00:00Z", from }), /not both/);
  assert.ok(MIN_RECURRENCE_MS >= 5 * 60 * 1000);
});

test("schedule_task tool creates a task anchored to the run's conversation and announces it", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeLinkedUser(teamId, "UALICE", "sched-alice");
  const doc = await db.document.create({
    data: { ownerId: alice.id, title: "#research", kind: "slack_channel", content: "{}", slackTeamId: teamId, slackChannelId: `C-${teamId}` }
  });
  const run = await db.aiRun.create({
    data: {
      documentId: doc.id,
      triggerType: "SLACK_MENTION",
      triggerId: `C-${teamId}:1000.000`,
      createdById: alice.id,
      instruction: "x"
    }
  });
  const { deps, posted } = makeDeps([]);
  const claims = { slackTeamId: teamId, slackUserId: "UALICE", aiRunId: run.id };

  const created = await handleSlackAgentToolCall(
    { tool: "schedule_task", args: { instruction: "post a daily digest", cron: "0 9 * * *", timezone: "UTC" } },
    { claims, slack: deps.slack, botUserId: BOT }
  );
  assert.ok(created.ok, created.text);
  assert.match(created.text, /Scheduled \(id /);

  const task = await db.scheduledTask.findFirst({ where: { documentId: doc.id, disabledAt: null } });
  assert.ok(task);
  assert.equal(task!.slackChannelId, `C-${teamId}`);
  assert.equal(task!.slackThreadTs, "1000.000");
  assert.equal(task!.createdById, alice.id);
  assert.equal(task!.cron, "0 9 * * *");
  assert.ok(posted.some((p) => p.text.includes("Scheduled task created") && p.text.includes(task!.id)));

  const listed = await handleSlackAgentToolCall(
    { tool: "list_scheduled_tasks", args: {} },
    { claims, slack: deps.slack, botUserId: BOT }
  );
  assert.match(listed.text, new RegExp(task!.id));

  const invalid = await handleSlackAgentToolCall(
    { tool: "schedule_task", args: { instruction: "too fast", cron: "* * * * *" } },
    { claims, slack: deps.slack, botUserId: BOT }
  );
  assert.equal(invalid.ok, false);
  assert.match(invalid.text, /at least 5 minutes/);

  const cancelled = await handleSlackAgentToolCall(
    { tool: "cancel_scheduled_task", args: { task_id: task!.id } },
    { claims, slack: deps.slack, botUserId: BOT }
  );
  assert.ok(cancelled.ok, cancelled.text);
  const after = await db.scheduledTask.findUnique({ where: { id: task!.id } });
  assert.ok(after!.disabledAt, "cancel must disable the task");
});

test("schedulerTick claims due tasks atomically and fires runs as the creator", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeLinkedUser(teamId, "UALICE", "tick-alice");
  const channel = `C-${teamId}`;
  const doc = await db.document.create({
    data: { ownerId: alice.id, title: "#research", kind: "slack_channel", content: "{}", slackTeamId: teamId, slackChannelId: channel }
  });
  const past = new Date(Date.now() - 60_000);
  const task = await db.scheduledTask.create({
    data: {
      documentId: doc.id,
      createdById: alice.id,
      instruction: "check the eval dashboard",
      contextType: "slack_thread",
      slackTeamId: teamId,
      slackChannelId: channel,
      slackThreadTs: "1000.000",
      cron: "0 9 * * *",
      timezone: "UTC",
      nextRunAt: past
    }
  });

  const runs: ConversationRunInput[] = [];
  const { deps, posted } = makeDeps(runs);
  const fired = await schedulerTick(new Date(), deps);
  assert.equal(fired, 1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].createdById, alice.id, "fires with the creator's identity");
  assert.match(runs[0].message, /Scheduled task firing/);
  assert.match(runs[0].message, /check the eval dashboard/);
  assert.ok(posted.some((p) => p.text.startsWith("⏰ Scheduled task:") && p.threadTs === "1000.000"));

  const bumped = await db.scheduledTask.findUnique({ where: { id: task.id } });
  assert.ok(bumped!.nextRunAt.getTime() > Date.now(), "recurring task advances nextRunAt");
  assert.ok(bumped!.lastFiredAt, "lastFiredAt stamped");
  assert.ok(bumped!.lastRunId, "run id recorded");

  // Second tick: nothing due anymore.
  const again = await schedulerTick(new Date(), deps);
  assert.equal(again, 0);
});

test("one-shot tasks disable after firing; unlinked creators disable the task", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeLinkedUser(teamId, "UALICE", "once-alice");
  const channel = `C-${teamId}`;
  const doc = await db.document.create({
    data: { ownerId: alice.id, title: "#research", kind: "slack_channel", content: "{}", slackTeamId: teamId, slackChannelId: channel }
  });
  const oneShot = await db.scheduledTask.create({
    data: {
      documentId: doc.id,
      createdById: alice.id,
      instruction: "one time thing",
      contextType: "slack_channel",
      slackTeamId: teamId,
      slackChannelId: channel,
      nextRunAt: new Date(Date.now() - 1000)
    }
  });
  const runs: ConversationRunInput[] = [];
  const { deps } = makeDeps(runs);
  const fired = await schedulerTick(new Date(), deps);
  assert.equal(fired, 1);
  const after = await db.scheduledTask.findUnique({ where: { id: oneShot.id } });
  assert.ok(after!.disabledAt, "one-shot task disables after firing");
  // Channel context: run replies into the fresh kickoff thread, not an old one.
  assert.equal(runs.length, 1);

  // A task whose creator has no Slack link in that team disables instead of running.
  const bob = await db.user.create({
    data: { email: `nolink-${crypto.randomUUID()}@example.com`, name: "nolink", passwordHash: "x" }
  });
  const orphan = await db.scheduledTask.create({
    data: {
      documentId: doc.id,
      createdById: bob.id,
      instruction: "orphaned",
      contextType: "slack_channel",
      slackTeamId: teamId,
      slackChannelId: channel,
      nextRunAt: new Date(Date.now() - 1000)
    }
  });
  const result = await fireScheduledTask(
    { ...orphan, timezone: null, cron: null, slackThreadTs: null },
    deps
  );
  assert.equal(result, null);
  const orphanAfter = await db.scheduledTask.findUnique({ where: { id: orphan.id } });
  assert.ok(orphanAfter!.disabledAt);
});
