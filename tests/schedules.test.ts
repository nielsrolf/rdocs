import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { upsertAgentApiChannel, revokeAgentApiChannel } from "../lib/agent-api-channels";
import { createChannelSchedule } from "../lib/agent-channel-schedules";
import { db, productionDatabaseRefusal } from "../lib/db";
import { createDocumentSchedule } from "../lib/document-schedules";
import { handleMcpMessage } from "../lib/mcp/server";
import type { McpToolContext } from "../lib/mcp/tools";
import { fireScheduledTask, schedulerTick } from "../lib/scheduler";
import {
  cancelSchedule,
  defaultTitle,
  describeCron,
  getScheduleHistory,
  listSchedulesForUser,
  runScheduleNow,
  ScheduleError,
  scheduleForRun,
  updateSchedule
} from "../lib/schedules";
import { handleSlackAgentToolCall } from "../lib/slack/agent-tools";
import type { SlackClient } from "../lib/slack/web";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

async function makeUser(label: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  return db.user.create({ data: { email: `${label}-${suffix}@example.com`, name: label, passwordHash: "x" } });
}

async function fixture() {
  const owner = await makeUser("sched-owner");
  const editor = await makeUser("sched-editor");
  const stranger = await makeUser("sched-stranger");
  const document = await db.document.create({ data: { title: "Dashboard", content: "{}", ownerId: owner.id } });
  await db.documentMembership.create({ data: { documentId: document.id, userId: editor.id, permission: "EDIT" } });
  const cleanup = async () => {
    await db.document.delete({ where: { id: document.id } }).catch(() => null);
    await db.user.deleteMany({ where: { id: { in: [owner.id, editor.id, stranger.id] } } }).catch(() => null);
  };
  return { owner, editor, stranger, document, cleanup };
}

test("the test suite refuses the production database", () => {
  assert.match(productionDatabaseRefusal({ NODE_TEST_CONTEXT: "child-v8", DATABASE_URL: "file:./dev.db" }) ?? "", /refusing/);
  assert.match(productionDatabaseRefusal({ npm_lifecycle_event: "test" }) ?? "", /refusing/, "unset URL falls back to .env = prod");
  assert.equal(productionDatabaseRefusal({ NODE_TEST_CONTEXT: "child-v8", DATABASE_URL: "file:./test.db" }), null);
  assert.equal(productionDatabaseRefusal({ DATABASE_URL: "file:./dev.db" }), null, "the server itself is not a test run");
  assert.equal(productionDatabaseRefusal({ NODE_TEST_CONTEXT: "x", DATABASE_URL: "file:/w/dev-data/rdocs.db" }), null);
});

test("cron expressions and titles render in plain words", () => {
  assert.equal(describeCron("0 8 * * *"), "Daily at 08:00");
  assert.equal(describeCron("30 9 * * 1-5"), "Weekdays at 09:30");
  assert.equal(describeCron("0 7 * * 1"), "Mondays at 07:00");
  assert.equal(describeCron("0 7 * * 1,3,5"), "Mon, Wed, Fri at 07:00");
  assert.equal(describeCron("15 * * * *"), "Hourly at :15");
  assert.equal(describeCron("*/30 * * * *"), "Every 30 minutes");
  assert.equal(describeCron("0 6 1 * *"), "Monthly on day 1 at 06:00");
  assert.equal(describeCron("0 6 1 1 *"), "cron 0 6 1 1 *");
  assert.equal(defaultTitle("[check_back_later wake-up — note]\nCheck the training run"), "Check the training run");
  assert.ok(defaultTitle("x".repeat(200)).length <= 60);
});

test("overview: creators and document editors see a task, strangers do not; wake-ups and ended tasks are opt-in", async (t) => {
  const { owner, editor, stranger, document, cleanup } = await fixture();
  t.after(cleanup);
  const job = await createDocumentSchedule({
    documentId: document.id,
    createdById: owner.id,
    title: "Morning refresh",
    instruction: "Refresh the dashboard.",
    cron: "0 7 * * *",
    timezone: "Europe/Berlin"
  });
  const wakeup = await db.scheduledTask.create({
    data: {
      documentId: document.id,
      createdById: owner.id,
      instruction: "[check_back_later wake-up] look at the job",
      kind: "wakeup",
      contextType: "document",
      nextRunAt: new Date(Date.now() + 60_000),
      disabledAt: new Date()
    }
  });

  const forOwner = await listSchedulesForUser(owner.id, { documentId: document.id });
  assert.deepEqual(forOwner.map((v) => v.id), [job.id]);
  assert.equal(forOwner[0].title, "Morning refresh");
  assert.equal(forOwner[0].schedule, "Daily at 07:00 (Europe/Berlin)");
  assert.equal(forOwner[0].status, "active");
  assert.equal(forOwner[0].canManage, true);
  assert.equal(forOwner[0].link, `/dashboard?tab=schedules#schedule-${job.id}`);

  assert.deepEqual((await listSchedulesForUser(editor.id, { documentId: document.id })).map((v) => v.id), [job.id]);
  assert.deepEqual(await listSchedulesForUser(stranger.id, { documentId: document.id }), []);

  const everything = await listSchedulesForUser(owner.id, { documentId: document.id, includeEnded: true, includeWakeups: true });
  assert.deepEqual(new Set(everything.map((v) => v.id)), new Set([job.id, wakeup.id]));
});

test("update: only creator or editors; pause stops firing, resume recomputes; timing is validated", async (t) => {
  const { owner, editor, stranger, document, cleanup } = await fixture();
  t.after(cleanup);
  await upsertAgentApiChannel({ documentId: document.id, createdById: owner.id, label: "test" });
  const created = await createChannelSchedule({
    documentId: document.id,
    createdById: owner.id,
    instruction: "Update this dashboard.",
    cron: "0 7 * * *",
    timezone: "Europe/Berlin"
  });
  assert.equal(created.title, "Update this dashboard.", "title defaults to the instruction's first line");

  await assert.rejects(updateSchedule(created.id, { title: "x" }, { userId: stranger.id }), (error: unknown) => {
    return error instanceof ScheduleError && error.status === 404;
  });

  const renamed = await updateSchedule(
    created.id,
    { title: "Daily dashboard update", cron: "30 6 * * 1-5" },
    { userId: editor.id }
  );
  assert.equal(renamed.title, "Daily dashboard update");
  assert.equal(renamed.schedule, "Weekdays at 06:30 (Europe/Berlin)");
  await assert.rejects(updateSchedule(created.id, { cron: "* * * * *" }, { userId: owner.id }), /at least 5 minutes/);
  await assert.rejects(updateSchedule(created.id, { timezone: "Mars/Olympus" }, { userId: owner.id }), /Unknown timezone/);

  const paused = await updateSchedule(created.id, { paused: true }, { userId: owner.id });
  assert.equal(paused.status, "paused");
  assert.equal(paused.nextRunAt, null);
  // Even when overdue, the poll loop leaves a paused task alone.
  await db.scheduledTask.update({ where: { id: created.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
  await schedulerTick(new Date());
  const untouched = await db.scheduledTask.findUniqueOrThrow({ where: { id: created.id } });
  assert.equal(untouched.lastFiredAt, null);

  const resumed = await updateSchedule(created.id, { paused: false }, { userId: owner.id });
  assert.equal(resumed.status, "active");
  assert.ok(new Date(resumed.nextRunAt!).getTime() > Date.now(), "missed occurrences are not backfilled");

  const cancelled = await cancelSchedule(created.id, { userId: editor.id });
  assert.equal(cancelled.status, "ended");
  assert.equal(cancelled.endedReason, "cancelled");
  await assert.rejects(updateSchedule(created.id, { title: "y" }, { userId: owner.id }), /ended/);
});

test("firing log: every attempt is recorded, including ones that never became a run", async (t) => {
  const { owner, stranger, document, cleanup } = await fixture();
  t.after(cleanup);
  await upsertAgentApiChannel({ documentId: document.id, createdById: owner.id, label: "test" });
  const schedule = await createChannelSchedule({
    documentId: document.id,
    createdById: owner.id,
    title: "Forecast round",
    instruction: "Refresh your forecasts.",
    cron: "0 7 * * *"
  });
  const hooks = {
    startRun: async ({ message }: { message: string }) => {
      // The firing message names the task, so the agent can change it in place.
      assert.match(message, /"Forecast round" \(id /);
      assert.match(message, /update_scheduled_task/);
      return "run-scheduled-1";
    }
  };
  const task = await db.scheduledTask.findUniqueOrThrow({ where: { id: schedule.id } });
  assert.equal(await fireScheduledTask(task, undefined, hooks as never), "run-scheduled-1");

  const manual = await runScheduleNow(schedule.id, { userId: owner.id }, { hooks: hooks as never });
  assert.equal(manual.outcome, "started");
  await assert.rejects(runScheduleNow(schedule.id, { userId: stranger.id }), ScheduleError);

  await revokeAgentApiChannel(document.id, owner.id);
  assert.equal(await fireScheduledTask(task, undefined, hooks as never), null);

  const history = await getScheduleHistory(schedule.id, { userId: owner.id });
  assert.deepEqual(
    history.map((f) => [f.outcome, f.trigger]),
    [
      ["disabled", "schedule"],
      ["started", "manual"],
      ["started", "schedule"]
    ]
  );
  assert.equal(history[0].detail, "API channel revoked");
  const after = await db.scheduledTask.findUniqueOrThrow({ where: { id: schedule.id } });
  assert.equal(after.lastOutcome, "disabled");
  assert.equal(after.endedReason, "API channel revoked");
  assert.deepEqual(await scheduleForRun("run-scheduled-1"), { id: schedule.id, title: "Forecast round" });
});

test("claudex tools: titles, scope=mine, update in place, history, and cancelling a non-Slack task", async (t) => {
  const { owner, stranger, document, cleanup } = await fixture();
  t.after(cleanup);
  const teamId = `T-${crypto.randomUUID()}`;
  await db.slackAccountLink.create({ data: { slackTeamId: teamId, slackUserId: "UOWNER", userId: owner.id } });
  const channelDoc = await db.document.create({
    data: { ownerId: owner.id, title: "DM", kind: "slack_channel", content: "{}", slackTeamId: teamId, slackChannelId: "D0OWNER" }
  });
  t.after(() => db.document.delete({ where: { id: channelDoc.id } }).catch(() => null));
  const run = await db.aiRun.create({
    data: { documentId: channelDoc.id, triggerType: "SLACK_MENTION", triggerId: "D0OWNER:1000.000", createdById: owner.id, instruction: "x" }
  });
  const posted: string[] = [];
  const slack = {
    async postMessage(args: { text: string }) {
      posted.push(args.text);
      return { ts: "1.0" };
    },
    async channelMembers() {
      return ["UBOT", "UOWNER"];
    }
  } as unknown as SlackClient;
  const call = (tool: string, args: Record<string, unknown>) =>
    handleSlackAgentToolCall(
      { tool: tool as never, args },
      { claims: { slackTeamId: teamId, slackUserId: "UOWNER", aiRunId: run.id }, slack, botUserId: "UBOT" }
    );

  const created = await call("schedule_task", {
    title: "Daily research check-in",
    instruction: "Read the ideas log and report at most 3 items.",
    cron: "0 8 * * *",
    timezone: "Europe/Berlin"
  });
  assert.ok(created.ok, created.text);
  assert.match(created.text, /dashboard\?tab=schedules#schedule-/);
  assert.deepEqual(posted, [], "no consent announcement in a DM");
  const task = await db.scheduledTask.findFirstOrThrow({ where: { documentId: channelDoc.id } });
  assert.equal(task.title, "Daily research check-in");
  assert.equal(task.kind, "job");

  const wake = await call("check_back_later", { after_minutes: 30, instruction: "Check the build log" });
  assert.ok(wake.ok, wake.text);
  const wakeTask = await db.scheduledTask.findFirstOrThrow({ where: { documentId: channelDoc.id, kind: "wakeup" } });
  assert.equal(wakeTask.title, "Wake-up: Check the build log");

  const docJob = await createDocumentSchedule({
    documentId: document.id,
    createdById: owner.id,
    title: "Dashboard refresh",
    instruction: "Refresh.",
    cron: "0 7 * * *"
  });

  const mine = await call("list_scheduled_tasks", { scope: "mine" });
  assert.match(mine.text, /Daily research check-in/);
  assert.match(mine.text, /Dashboard refresh/);
  assert.doesNotMatch(mine.text, /Wake-up/, "scope=mine hides wake-ups by default");
  const channel = await call("list_scheduled_tasks", {});
  assert.match(channel.text, /Wake-up: Check the build log/, "the channel scope keeps the agent's own alarms visible");

  const updated = await call("update_scheduled_task", { task_id: task.id, cron: "0 8 * * 1-5", title: "Weekday check-in" });
  assert.ok(updated.ok, updated.text);
  assert.match(updated.text, /Weekdays at 08:00 \(Europe\/Berlin\)/);
  const paused = await call("update_scheduled_task", { task_id: task.id, paused: true });
  assert.match(paused.text, /paused/);
  const refused = await call("update_scheduled_task", { task_id: wakeTask.id, paused: true });
  assert.equal(refused.ok, false);

  const history = await call("get_scheduled_task_history", { task_id: task.id });
  assert.ok(history.ok);
  assert.match(history.text, /has not fired yet/);

  // A document job is cancellable from Slack by its creator…
  const cancelled = await call("cancel_scheduled_task", { task_id: docJob.id });
  assert.ok(cancelled.ok, cancelled.text);
  // …but a stranger's own Slack identity gets nothing (no link → refused).
  const strangerTask = await createDocumentSchedule({
    documentId: document.id,
    createdById: owner.id,
    instruction: "Not yours.",
    cron: "0 9 * * *"
  });
  await assert.rejects(cancelSchedule(strangerTask.id, { userId: stranger.id }), ScheduleError);
  await db.scheduledTask.updateMany({ where: { documentId: { in: [document.id, channelDoc.id] } }, data: { disabledAt: new Date() } });
});

test("MCP: list without a document shows everything the user can see; update and history work; confined runs stay on their document", async (t) => {
  const { owner, document, cleanup } = await fixture();
  t.after(cleanup);
  const other = await db.document.create({ data: { title: "Other", content: "{}", ownerId: owner.id } });
  t.after(() => db.document.delete({ where: { id: other.id } }).catch(() => null));
  const onOther = await createDocumentSchedule({ documentId: other.id, createdById: owner.id, instruction: "Other job.", cron: "0 9 * * *" });
  const onDoc = await createDocumentSchedule({ documentId: document.id, createdById: owner.id, instruction: "Doc job.", cron: "0 9 * * *" });

  const ctx = (scopeDocumentId?: string): McpToolContext => ({
    user: { id: owner.id, email: owner.email, name: owner.name },
    origin: "http://localhost:14141",
    scopeDocumentId
  });
  const call = async (c: McpToolContext, name: string, args: unknown) => {
    const response = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, c);
    assert.ok(response && "result" in response);
    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    return { isError: result.isError, text: result.content[0].text };
  };

  const listed = await call(ctx(), "list_scheduled_tasks", {});
  assert.equal(listed.isError, false, listed.text);
  const ids = (JSON.parse(listed.text).tasks as Array<{ id: string }>).map((task) => task.id);
  assert.ok(ids.includes(onOther.id) && ids.includes(onDoc.id));

  const confined = await call(ctx(document.id), "list_scheduled_tasks", {});
  assert.deepEqual((JSON.parse(confined.text).tasks as Array<{ id: string }>).map((task) => task.id), [onDoc.id]);
  const refused = await call(ctx(document.id), "update_scheduled_task", { task_id: onOther.id, title: "nope" });
  assert.equal(refused.isError, true);

  const updated = await call(ctx(document.id), "update_scheduled_task", { task_id: onDoc.id, title: "Renamed", paused: true });
  assert.equal(updated.isError, false, updated.text);
  assert.equal(JSON.parse(updated.text).updated.status, "paused");
  const history = await call(ctx(), "get_scheduled_task_history", { task_id: onDoc.id });
  assert.deepEqual(JSON.parse(history.text).firings, []);
  const cancelled = await call(ctx(), "cancel_scheduled_task", { task_id: onOther.id });
  assert.equal(cancelled.isError, false, cancelled.text);
  await db.scheduledTask.updateMany({ where: { documentId: { in: [document.id, other.id] } }, data: { disabledAt: new Date() } });
});
