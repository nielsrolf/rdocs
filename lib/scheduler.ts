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

import { API_CHANNEL_CONTEXT, fireApiChannelTask, type ApiChannelTaskHooks } from "@/lib/agent-channel-schedules";
import { db } from "@/lib/db";
import {
  buildSteeringMessage,
  startSlackConversationRun,
  steerActiveThreadRun,
  type SlackEventDeps
} from "@/lib/slack/events";
import { resolveHostDevDir } from "@/lib/slack/dev-mode";
import { slackTeamContext } from "@/lib/slack/installations";

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
  slackTeamId: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  cron: string | null;
  timezone: string | null;
  nextRunAt: Date;
};

export const BEAT_DEFER_MS = 2 * 60_000;
export const MAX_BEAT_DEFER_MS = 30 * 60_000;

// Put a claimed-but-undeliverable beat back on the queue instead of dropping it.
// `task` is the PRE-claim snapshot, so task.nextRunAt is the occurrence's original
// due time — that is what bounds how long we keep retrying.
async function deferBeat(task: ScheduledTaskRow): Promise<Date | null> {
  const overdueMs = Date.now() - task.nextRunAt.getTime();
  if (overdueMs > MAX_BEAT_DEFER_MS) {
    console.error("[scheduler] giving up on beat: the thread stayed busy too long", {
      taskId: task.id,
      overdueMs
    });
    return null;
  }
  const retryAt = new Date(Date.now() + BEAT_DEFER_MS);
  // A one-shot was disabled by its own claim, so reviving it means clearing
  // disabledAt. (Narrow race: a cancel landing inside the retry window is undone;
  // the next attempt is at most BEAT_DEFER_MS away and cancel works again then.)
  const updated = await db.scheduledTask
    .updateMany({
      where: { id: task.id },
      data: { nextRunAt: retryAt, ...(task.cron ? {} : { disabledAt: null }) }
    })
    .catch(() => null);
  return updated?.count === 1 ? retryAt : null;
}

// Fire one claimed task. deps injectable for tests; production builds real
// Slack deps from the environment.
export async function fireScheduledTask(
  task: ScheduledTaskRow,
  deps?: SlackEventDeps,
  hooks?: ApiChannelTaskHooks
) {
  if (task.contextType === API_CHANNEL_CONTEXT) return fireApiChannelTask(task, hooks);
  if (!task.slackTeamId || !task.slackChannelId) {
    console.error("[scheduler] disabling slack task without a channel", { taskId: task.id });
    await db.scheduledTask.update({ where: { id: task.id }, data: { disabledAt: new Date() } }).catch(() => null);
    return null;
  }
  const slackChannelId = task.slackChannelId;
  const resolvedDeps = deps ?? (await buildSlackDeps(task.slackTeamId));
  if (!resolvedDeps) {
    console.warn("[scheduler] slack not configured for this workspace; skipping task", {
      taskId: task.id,
      slackTeamId: task.slackTeamId
    });
    return null;
  }
  const document = await db.document.findUnique({
    where: { id: task.documentId },
    select: { id: true, title: true, content: true, agentModel: true, agentEffort: true, runnerMode: true }
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
    select: { slackUserId: true, user: { select: { email: true } } }
  });
  if (!link) {
    await db.scheduledTask.update({ where: { id: task.id }, data: { disabledAt: new Date() } }).catch(() => null);
    return null;
  }

  // Kickoff message: ONLY for channel context, where each firing starts a
  // fresh top-level thread — the kickoff's ts is that thread's root (and the
  // reaction anchor). Thread-context firings post no kickoff: the run replies
  // into the existing thread anyway, and the raw instruction is agent-facing
  // noise there (users already saw the schedule confirmation).
  const isThreadContext = task.contextType === "slack_thread" && !!task.slackThreadTs;
  const kickoff = isThreadContext
    ? { ts: undefined as string | undefined }
    : await resolvedDeps.slack.postMessage({
        channel: slackChannelId,
        text: `⏰ Scheduled task: ${task.instruction.slice(0, 200)}`
      });
  const threadRoot = isThreadContext ? task.slackThreadTs ?? undefined : kickoff.ts ?? undefined;
  const triggerId = threadRoot ? `${slackChannelId}:${threadRoot}` : `${slackChannelId}:scheduled`;

  // One active agent session per Slack thread. If the thread this task fires
  // into is already working, the firing is STEERING for that session, not a
  // second run: stacked runs all park on the per-conversation session lock, so
  // they look hung, never reply, and make follow-up messages unsteerable.
  const instruction = `[Scheduled task firing — set up earlier in this conversation]\n${task.instruction}`;
  const live = await steerActiveThreadRun({
    documentId: document.id,
    triggerId,
    text: buildSteeringMessage("the task scheduler", instruction),
    timelineMessage: instruction,
    inject: resolvedDeps.injectRunMessage
  });
  if (live.steeredRunId) {
    console.log("[scheduler] firing injected into the thread's live run", {
      taskId: task.id,
      aiRunId: live.steeredRunId
    });
    await db.scheduledTask.update({
      where: { id: task.id },
      data: { lastRunId: live.steeredRunId }
    }).catch(() => null);
    return live.steeredRunId;
  }
  if (live.activeRunIds.length > 0) {
    // The thread has an active run we cannot steer (another server process after
    // a deploy, a Codex run, or a zombie the reaper has not collected yet).
    // Starting a second run would stack on the per-conversation session lock, so
    // DEFER the beat instead of dropping it: the claim above already advanced
    // (and, for a one-shot, disabled) this task, so returning here used to lose a
    // check_back_later wake-up forever. Retry shortly — the blocking run either
    // finishes or gets reaped within STALE_AI_RUN_MS.
    const deferred = await deferBeat(task);
    console.warn("[scheduler] deferring beat: thread has an active run that cannot be steered", {
      taskId: task.id,
      activeRunIds: live.activeRunIds,
      retryAt: deferred?.toISOString() ?? null
    });
    return null;
  }

  const previousRun = await db.aiRun.findFirst({
    where: { documentId: document.id, triggerId, status: { in: ["SUCCEEDED", "FAILED"] } },
    orderBy: { startedAt: "desc" },
    select: { id: true }
  });

  const isDm = slackChannelId.startsWith("D");
  const channelName = isDm ? null : (await resolvedDeps.slack.channelInfo(slackChannelId))?.name ?? null;
  // Host dev mode must survive scheduled wake-ups: a check_back_later alarm set
  // by a host-dev run fires a fresh follow-up run here, and losing hostDevDir
  // containerized it — thread/resume then failed on the host-only rollout file
  // (2026-08-23, #lenovo). Same resolution as the mention handler, keyed on the
  // task CREATOR (the run executes as them).
  const hostDevDir = resolveHostDevDir(slackChannelId, channelName, link.user.email);
  const aiRunId = await startSlackConversationRun({
    deps: resolvedDeps,
    surface: isDm ? "dm" : "mention",
    document,
    channel: slackChannelId,
    channelName,
    teamId: task.slackTeamId,
    triggerId,
    replyThreadTs: threadRoot,
    reactionAnchors: kickoff.ts ? [{ ts: kickoff.ts }] : [],
    instruction,
    userId: task.createdById,
    slackUserId: link.slackUserId,
    parentRunId: previousRun?.id ?? null,
    channelContext: null,
    hostDevDir
  });
  await db.scheduledTask.update({
    where: { id: task.id },
    data: { lastRunId: aiRunId }
  }).catch(() => null);
  return aiRunId;
}

// Bot client for the TASK's workspace (multi-workspace installs) — the
// scheduler fires tasks from every team the app is installed in.
async function buildSlackDeps(teamId: string): Promise<SlackEventDeps | null> {
  const context = await slackTeamContext(teamId);
  if (!context) return null;
  return { slack: context.slack, appUrl: context.appUrl, botUserId: context.botUserId };
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

// Graceful drain (blue/green deploy): the outgoing process must stop claiming
// scheduled tasks so every future firing happens on the new process. The
// atomic nextRunAt claim already prevents double-fires during overlap; this
// just stops the old process from stealing claims after the LB switch.
export function stopSchedulerLoop() {
  if (!loop) return;
  clearInterval(loop);
  loop = null;
  console.log("[scheduler] poll loop stopped (drain)");
}
