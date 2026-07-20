// Scheduled agent tasks (created from Slack via the schedule_task tool).
//
// A 30s poll loop claims due ScheduledTask rows and fires each as a normal
// Slack conversation run (startSlackConversationRun), so replies, reactions,
// interrupt handling and credential attribution behave exactly like a typed
// message from the task's creator. Claiming is optimistic: the row's
// nextRunAt is advanced (or the task disabled, for one-shots) with a
// conditional update BEFORE firing, so a crashed firing skips a beat instead
// of double-running, and an overdue task fires once rather than backfilling.

import { CronExpressionParser } from "cron-parser";

import { db } from "@/lib/db";
import { startSlackConversationRun, type SlackEventDeps } from "@/lib/slack/events";
import { createSlackWebClient, slackAuthTest } from "@/lib/slack/web";

export const MIN_RECURRENCE_MS = 5 * 60 * 1000;
export const MAX_ACTIVE_TASKS_PER_DOCUMENT = 20;

export function computeNextRunAt(input: {
  cron?: string | null;
  at?: string | null;
  timezone?: string | null;
  from?: Date;
}): Date {
  const from = input.from ?? new Date();
  if (input.cron && input.at) {
    throw new Error("Provide either cron (recurring) or at (one-shot), not both.");
  }
  if (input.cron) {
    const options = { currentDate: from, ...(input.timezone ? { tz: input.timezone } : {}) };
    const expression = CronExpressionParser.parse(input.cron, options);
    const first = expression.next().toDate();
    const second = expression.next().toDate();
    if (second.getTime() - first.getTime() < MIN_RECURRENCE_MS) {
      throw new Error("Schedule too frequent: firings must be at least 5 minutes apart.");
    }
    return first;
  }
  if (input.at) {
    const at = new Date(input.at);
    if (Number.isNaN(at.getTime())) {
      throw new Error(`Invalid timestamp: ${input.at}. Use ISO-8601, e.g. 2026-07-21T09:00:00+02:00.`);
    }
    if (at.getTime() <= from.getTime()) {
      throw new Error("The one-shot time is in the past.");
    }
    return at;
  }
  throw new Error("Provide cron (recurring) or at (one-shot).");
}

type ScheduledTaskRow = {
  id: string;
  documentId: string;
  createdById: string | null;
  instruction: string;
  contextType: string;
  slackTeamId: string;
  slackChannelId: string;
  slackThreadTs: string | null;
  cron: string | null;
  timezone: string | null;
  nextRunAt: Date;
};

// Fire one claimed task. deps injectable for tests; production builds real
// Slack deps from the environment.
export async function fireScheduledTask(task: ScheduledTaskRow, deps?: SlackEventDeps) {
  const resolvedDeps = deps ?? (await buildSlackDeps());
  if (!resolvedDeps) {
    console.warn("[scheduler] slack not configured; skipping task", { taskId: task.id });
    return null;
  }
  const document = await db.document.findUnique({
    where: { id: task.documentId },
    select: { id: true, title: true, content: true, agentModel: true, agentEffort: true }
  });
  if (!document || !task.createdById) {
    await db.scheduledTask.update({
      where: { id: task.id },
      data: { disabledAt: new Date() }
    }).catch(() => null);
    return null;
  }
  const link = await db.slackAccountLink.findFirst({
    where: { slackTeamId: task.slackTeamId, userId: task.createdById },
    select: { slackUserId: true }
  });
  if (!link) {
    await db.scheduledTask.update({ where: { id: task.id }, data: { disabledAt: new Date() } }).catch(() => null);
    return null;
  }

  // Kickoff message: in-thread for thread context; top-level (starting a fresh
  // thread per firing) for channel context. Its ts is the reaction anchor.
  const kickoffText = `⏰ Scheduled task: ${task.instruction.slice(0, 200)}`;
  const kickoff = await resolvedDeps.slack.postMessage({
    channel: task.slackChannelId,
    text: kickoffText,
    ...(task.contextType === "slack_thread" && task.slackThreadTs ? { threadTs: task.slackThreadTs } : {})
  });
  const threadRoot =
    task.contextType === "slack_thread" && task.slackThreadTs ? task.slackThreadTs : kickoff.ts ?? undefined;
  const triggerId = threadRoot ? `${task.slackChannelId}:${threadRoot}` : `${task.slackChannelId}:scheduled`;

  const previousRun = await db.aiRun.findFirst({
    where: { documentId: document.id, triggerId, status: { in: ["SUCCEEDED", "FAILED"] } },
    orderBy: { startedAt: "desc" },
    select: { id: true }
  });

  const isDm = task.slackChannelId.startsWith("D");
  const channelName = isDm ? null : (await resolvedDeps.slack.channelInfo(task.slackChannelId))?.name ?? null;
  const aiRunId = await startSlackConversationRun({
    deps: resolvedDeps,
    surface: isDm ? "dm" : "mention",
    document,
    channel: task.slackChannelId,
    channelName,
    teamId: task.slackTeamId,
    triggerId,
    replyThreadTs: threadRoot,
    reactionAnchors: kickoff.ts ? [{ ts: kickoff.ts }] : [],
    instruction: `[Scheduled task firing — set up earlier in this conversation]\n${task.instruction}`,
    userId: task.createdById,
    slackUserId: link.slackUserId,
    parentRunId: previousRun?.id ?? null,
    channelContext: null
  });
  await db.scheduledTask.update({
    where: { id: task.id },
    data: { lastRunId: aiRunId }
  }).catch(() => null);
  return aiRunId;
}

let cachedDeps: SlackEventDeps | null = null;

async function buildSlackDeps(): Promise<SlackEventDeps | null> {
  if (cachedDeps) return cachedDeps;
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  if (!botToken) return null;
  const auth = await slackAuthTest(botToken).catch(() => null);
  if (!auth?.userId) return null;
  cachedDeps = {
    slack: createSlackWebClient(botToken),
    appUrl: process.env.APP_URL?.trim() || "http://localhost:14141",
    botUserId: auth.userId
  };
  return cachedDeps;
}

export async function schedulerTick(now = new Date(), deps?: SlackEventDeps) {
  const due = await db.scheduledTask.findMany({
    where: { disabledAt: null, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: 10
  });
  let fired = 0;
  for (const task of due) {
    // Advance/disable BEFORE firing; the conditional where makes the claim
    // atomic so a concurrent tick can't double-fire the same occurrence.
    let next: Date | null = null;
    if (task.cron) {
      try {
        next = computeNextRunAt({ cron: task.cron, timezone: task.timezone, from: now });
      } catch (error) {
        console.error("[scheduler] disabling task with invalid cron", {
          taskId: task.id,
          error: error instanceof Error ? error.message : error
        });
      }
    }
    const claim = await db.scheduledTask.updateMany({
      where: { id: task.id, nextRunAt: task.nextRunAt, disabledAt: null },
      data: {
        lastFiredAt: now,
        ...(next ? { nextRunAt: next } : { disabledAt: now })
      }
    });
    if (claim.count !== 1) continue;
    fired++;
    await fireScheduledTask(task, deps).catch((error) => {
      console.error("[scheduler] task firing failed", {
        taskId: task.id,
        error: error instanceof Error ? error.message : error
      });
    });
  }
  return fired;
}

let loop: NodeJS.Timeout | null = null;

export function startSchedulerLoop(intervalMs = 30_000) {
  if (loop) return;
  let ticking = false;
  loop = setInterval(() => {
    if (ticking) return;
    ticking = true;
    schedulerTick()
      .catch((error) => {
        console.error("[scheduler] tick failed", {
          error: error instanceof Error ? error.message : error
        });
      })
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);
  loop.unref?.();
  console.log("[scheduler] poll loop started", { intervalMs });
}
