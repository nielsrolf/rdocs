import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import {
  computeNextRunAt,
  fireScheduledTask,
  schedulerTick,
  MAX_BEAT_DEFER_MS,
  MIN_RECURRENCE_MS
} from "../lib/scheduler";
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
    },
    async downloadFile() {
      return null;
    },
    async uploadFile() {}
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
  // Thread-context firings must NOT post a kickoff message: the run replies
  // into the existing thread anyway, and the raw instruction is agent-facing.
  assert.ok(!posted.some((p) => p.text.startsWith("⏰ Scheduled task:")), "no kickoff in thread context");

  const bumped = await db.scheduledTask.findUnique({ where: { id: task.id } });
  assert.ok(bumped!.nextRunAt.getTime() > Date.now(), "recurring task advances nextRunAt");
  assert.ok(bumped!.lastFiredAt, "lastFiredAt stamped");
  assert.ok(bumped!.lastRunId, "run id recorded");

  // Second tick: nothing due anymore.
  const again = await schedulerTick(new Date(), deps);
  assert.equal(again, 0);

  // Tests share the REAL database with the running service. A recurring task
  // left enabled here is picked up by the production scheduler the next
  // morning and fires a real agent run (this happened: dozens of leaked
  // "check the eval dashboard" tasks spawned 24 containers at 09:00). Always
  // disable fixture tasks before the test ends.
  await db.scheduledTask.updateMany({ where: { documentId: doc.id }, data: { disabledAt: new Date() } });
  const cleaned = await db.scheduledTask.findFirst({ where: { documentId: doc.id, disabledAt: null } });
  assert.equal(cleaned, null, "scheduler test must not leak enabled tasks into the shared DB");
});

test("a thread-context firing injects into the thread's live run instead of stacking a run", async () => {
  // Real failure (2026-08-10): a 2-hourly task fired into a DM thread that
  // already had a RUNNING run. Each firing started ANOTHER run, all parked on
  // the per-conversation session lock. Never more than one active session per
  // Slack thread: a firing during an active run is steering, not a new run.
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeLinkedUser(teamId, "UALICE", "sched-inject");
  const channel = `D-${teamId}`;
  const doc = await db.document.create({
    data: {
      ownerId: alice.id,
      title: "dm",
      kind: "slack_channel",
      content: "{}",
      slackTeamId: teamId,
      slackChannelId: channel
    }
  });
  const threadTs = "5000.000";
  const active = await db.aiRun.create({
    data: {
      documentId: doc.id,
      triggerType: "SLACK_MENTION",
      triggerId: `${channel}:${threadTs}`,
      createdById: alice.id,
      instruction: "long running work"
    }
  });

  const runs: ConversationRunInput[] = [];
  const { deps } = makeDeps(runs);
  const injected: Array<{ aiRunId: string; text: string }> = [];
  const task = {
    id: `fake-${crypto.randomUUID()}`,
    documentId: doc.id,
    createdById: alice.id,
    instruction: "resume the eval sweep",
    contextType: "slack_thread",
    slackTeamId: teamId,
    slackChannelId: channel,
    slackThreadTs: threadTs,
    cron: null,
    timezone: null,
    nextRunAt: new Date()
  };

  const fired = await fireScheduledTask(task, {
    ...deps,
    injectRunMessage: (aiRunId, text) => {
      injected.push({ aiRunId, text });
      return true;
    }
  });
  assert.equal(fired, active.id, "firing reports the run it steered");
  assert.equal(runs.length, 0, "no stacked run while one is active in the thread");
  assert.equal(injected.length, 1);
  assert.equal(injected[0].aiRunId, active.id);
  assert.match(injected[0].text, /resume the eval sweep/);

  // When the live run cannot accept it, the beat is skipped — still no stack.
  const skipped = await fireScheduledTask(task, { ...deps, injectRunMessage: () => false });
  assert.equal(skipped, null);
  assert.equal(runs.length, 0, "an unsteerable active run skips the beat rather than stacking");

  await db.aiRun.update({ where: { id: active.id }, data: { status: "FAILED" } });
});

test("a scheduled firing in a host-dev channel keeps host-dev mode", async () => {
  // Real failure (2026-08-23, #lenovo): a Codex host-dev run called
  // check_back_later and ended its turn; the wake-up fired a fresh follow-up
  // run WITHOUT hostDevDir, so it ran containerized and thread/resume could
  // not find the host-side rollout file. The scheduler must resolve host-dev
  // mode exactly like the mention handler does.
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeLinkedUser(teamId, "UALICE", "sched-hostdev");
  const aliceRow = await db.user.findUnique({ where: { id: alice.id }, select: { email: true } });
  const channel = `C-${teamId}`;
  const doc = await db.document.create({
    data: {
      ownerId: alice.id,
      title: "#research",
      kind: "slack_channel",
      content: "{}",
      slackTeamId: teamId,
      slackChannelId: channel
    }
  });
  const runs: ConversationRunInput[] = [];
  const { deps } = makeDeps(runs); // channelInfo reports the name "research"
  // In-memory task row (never persisted) — no risk of leaking an enabled task.
  const task = {
    id: `fake-${crypto.randomUUID()}`,
    documentId: doc.id,
    createdById: alice.id,
    instruction: "check whether the install finished",
    contextType: "slack_thread",
    slackTeamId: teamId,
    slackChannelId: channel,
    slackThreadTs: "7000.000",
    cron: null,
    timezone: null,
    nextRunAt: new Date()
  };

  const prevDirs = process.env.SLACK_DEV_CHANNEL_DIRS;
  const prevEmails = process.env.SLACK_DEV_ALLOWED_EMAILS;
  process.env.SLACK_DEV_CHANNEL_DIRS = "#research=/tmp/sched-hostdev";
  process.env.SLACK_DEV_ALLOWED_EMAILS = aliceRow!.email;
  try {
    const fired = await fireScheduledTask(task, deps);
    assert.ok(fired, "the firing starts a run");
    assert.equal(runs.length, 1);
    assert.equal(
      runs[0].hostDevDir,
      "/tmp/sched-hostdev",
      "a wake-up in a host-dev channel must stay a host-dev run"
    );
    await db.aiRun.update({ where: { id: fired! }, data: { status: "FAILED" } });
  } finally {
    if (prevDirs === undefined) delete process.env.SLACK_DEV_CHANNEL_DIRS;
    else process.env.SLACK_DEV_CHANNEL_DIRS = prevDirs;
    if (prevEmails === undefined) delete process.env.SLACK_DEV_ALLOWED_EMAILS;
    else process.env.SLACK_DEV_ALLOWED_EMAILS = prevEmails;
  }
});

test("a beat that cannot be delivered is deferred, not lost", async () => {
  // Real failure (2026-08-10): a check_back_later wake-up fired into a thread
  // whose active run could not be steered (other process after a deploy, Codex
  // run, or an uncollected zombie). The claim had already disabled the one-shot,
  // so returning early lost the alarm FOREVER and the agent was never woken.
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeLinkedUser(teamId, "UALICE", "sched-defer");
  const channel = `D-${teamId}`;
  const doc = await db.document.create({
    data: {
      ownerId: alice.id,
      title: "dm",
      kind: "slack_channel",
      content: "{}",
      slackTeamId: teamId,
      slackChannelId: channel
    }
  });
  const threadTs = "6000.000";
  const active = await db.aiRun.create({
    data: {
      documentId: doc.id,
      triggerType: "SLACK_MENTION",
      triggerId: `${channel}:${threadTs}`,
      createdById: alice.id,
      instruction: "parked on a check_back_later"
    }
  });
  const wakeUp = await db.scheduledTask.create({
    data: {
      documentId: doc.id,
      createdById: alice.id,
      instruction: "check whether the training run finished",
      contextType: "slack_thread",
      slackTeamId: teamId,
      slackChannelId: channel,
      slackThreadTs: threadTs,
      nextRunAt: new Date(Date.now() - 1000)
    }
  });

  const runs: ConversationRunInput[] = [];
  const { deps } = makeDeps(runs);
  // schedulerTick claims (and, for a one-shot, disables) the task before firing.
  const fired = await schedulerTick(new Date(), { ...deps, injectRunMessage: () => false });
  assert.equal(fired, 1);
  assert.equal(runs.length, 0, "still no stacked run in a thread with an active session");

  const deferred = await db.scheduledTask.findUnique({ where: { id: wakeUp.id } });
  assert.equal(deferred!.disabledAt, null, "the undeliverable one-shot is re-armed, not left disabled");
  assert.ok(deferred!.nextRunAt.getTime() > Date.now(), "and it retries in the future");
  assert.ok(
    deferred!.nextRunAt.getTime() < Date.now() + 10 * 60_000,
    "retry must be soon — the blocking run finishes or gets reaped within STALE_AI_RUN_MS"
  );

  // Give-up bound: a beat that has been overdue for longer than
  // MAX_BEAT_DEFER_MS stops retrying instead of looping forever.
  await db.scheduledTask.update({
    where: { id: wakeUp.id },
    data: { nextRunAt: new Date(Date.now() - (MAX_BEAT_DEFER_MS + 60_000)), disabledAt: null }
  });
  const staleFired = await schedulerTick(new Date(), { ...deps, injectRunMessage: () => false });
  assert.equal(staleFired, 1);
  const abandoned = await db.scheduledTask.findUnique({ where: { id: wakeUp.id } });
  assert.ok(abandoned!.disabledAt, "a hopelessly overdue beat gives up rather than retrying forever");
  assert.equal(runs.length, 0);

  await db.scheduledTask.updateMany({ where: { documentId: doc.id }, data: { disabledAt: new Date() } });
  const leaked = await db.scheduledTask.findFirst({ where: { documentId: doc.id, disabledAt: null } });
  assert.equal(leaked, null, "scheduler test must not leak enabled tasks into the shared DB");
  await db.aiRun.update({ where: { id: active.id }, data: { status: "FAILED" } });
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
  const { deps, posted } = makeDeps(runs);
  const fired = await schedulerTick(new Date(), deps);
  assert.equal(fired, 1);
  const after = await db.scheduledTask.findUnique({ where: { id: oneShot.id } });
  assert.ok(after!.disabledAt, "one-shot task disables after firing");
  // Channel context: run replies into the fresh kickoff thread, not an old one.
  assert.equal(runs.length, 1);
  // Channel context DOES post a kickoff — its ts is the thread root each
  // firing replies into.
  assert.ok(posted.some((p) => p.text.startsWith("⏰ Scheduled task:")), "kickoff required in channel context");

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

test("schedule_task / cancel in a DM stays agent-facing: no channel announcements", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeLinkedUser(teamId, "UALICE", "dm-alice");
  const dmChannel = `D-${teamId}`;
  const doc = await db.document.create({
    data: { ownerId: alice.id, title: "dm", kind: "slack_channel", content: "{}", slackTeamId: teamId, slackChannelId: dmChannel }
  });
  const run = await db.aiRun.create({
    data: {
      documentId: doc.id,
      triggerType: "SLACK_MENTION",
      triggerId: `${dmChannel}:2000.000`,
      createdById: alice.id,
      instruction: "x"
    }
  });
  const { deps, posted } = makeDeps([]);
  const claims = { slackTeamId: teamId, slackUserId: "UALICE", aiRunId: run.id };

  const created = await handleSlackAgentToolCall(
    { tool: "schedule_task", args: { instruction: "remind me", at: new Date(Date.now() + 3600_000).toISOString() } },
    { claims, slack: deps.slack, botUserId: BOT }
  );
  assert.ok(created.ok, created.text);
  assert.equal(posted.length, 0, "DM scheduling must not post an announcement — the agent's own reply covers it");

  const task = await db.scheduledTask.findFirst({ where: { documentId: doc.id, disabledAt: null } });
  assert.ok(task);
  const cancelled = await handleSlackAgentToolCall(
    { tool: "cancel_scheduled_task", args: { task_id: task!.id } },
    { claims, slack: deps.slack, botUserId: BOT }
  );
  assert.ok(cancelled.ok, cancelled.text);
  assert.equal(posted.length, 0, "DM cancel must not post an announcement");
});
