// Scheduled agent tasks (created from Slack via the schedule_task tool).
//
// A 30s poll loop claims due ScheduledTask rows and fires each as a normal
// Slack conversation run (startSlackConversationRun), so replies, reactions,
// interrupt handling and credential attribution behave exactly like a typed
// message from the task's creator. Claiming is optimistic: the row's
// nextRunAt is advanced (or the task disabled, for one-shots) with a
// conditional update BEFORE firing, so a crashed firing skips a beat instead
// of double-running, and an overdue task fires once rather than backfilling.

import { API_CHANNEL_CONTEXT, fireApiChannelTaskOutcome, type ApiChannelTaskHooks } from "@/lib/agent-channel-schedules";
import { db } from "@/lib/db";
import { DOCUMENT_CONTEXT, fireDocumentTaskOutcome, type DocumentTaskHooks } from "@/lib/document-schedules";
import { computeNextRunAt, endTask, firingHeader, recordFiring, type FiringResult } from "@/lib/schedules";
import {
  buildSteeringMessage,
  startSlackConversationRun,
  steerActiveThreadRun,
  type SlackEventDeps
} from "@/lib/slack/events";
import { resolveHostDevDir } from "@/lib/slack/dev-mode";
import { slackTeamContext } from "@/lib/slack/installations";

// Timing rules live in lib/schedules.ts (the shared schedule service); these
// re-exports keep the historical import paths working.
export { computeNextRunAt, firingHeader, MAX_ACTIVE_TASKS_PER_DOCUMENT, MIN_RECURRENCE_MS } from "@/lib/schedules";

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
  title?: string | null;
  kind?: string;
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
      data: { nextRunAt: retryAt, ...(task.cron ? {} : { disabledAt: null, endedReason: null }) }
    })
    .catch(() => null);
  return updated?.count === 1 ? retryAt : null;
}

export type FireOptions = {
  deps?: SlackEventDeps;
  hooks?: ApiChannelTaskHooks & DocumentTaskHooks;
  // "manual" = Run now from the Schedules UI / an agent tool: never touches the
  // schedule itself (no beat deferral), and is logged as such.
  trigger?: "schedule" | "manual";
};

// Fire one claimed task. deps injectable for tests; production builds real
// Slack deps from the environment. Returns the run id (or null when no run
// started); every attempt is recorded in the firing log.
export async function fireScheduledTask(
  task: ScheduledTaskRow,
  deps?: SlackEventDeps,
  hooks?: ApiChannelTaskHooks & DocumentTaskHooks
): Promise<string | null> {
  const result = await fireScheduledTaskWithResult(task, { deps, hooks });
  return result.runId ?? null;
}

export async function fireScheduledTaskWithResult(task: ScheduledTaskRow, options: FireOptions = {}): Promise<FiringResult> {
  const trigger = options.trigger ?? "schedule";
  let result: FiringResult;
  try {
    result = await fireOnce(task, options);
  } catch (error) {
    result = { outcome: "error", detail: error instanceof Error ? error.message : String(error) };
    console.error("[scheduler] task firing failed", { taskId: task.id, trigger, error: result.detail });
  }
  await recordFiring(task.id, { ...result, trigger });
  return result;
}

async function fireOnce(task: ScheduledTaskRow, { deps, hooks, trigger = "schedule" }: FireOptions): Promise<FiringResult> {
  if (task.contextType === API_CHANNEL_CONTEXT) return fireApiChannelTaskOutcome(task, hooks);
  if (task.contextType === DOCUMENT_CONTEXT) return fireDocumentTaskOutcome(task, hooks);
  if (!task.slackTeamId || !task.slackChannelId) {
    console.error("[scheduler] disabling slack task without a channel", { taskId: task.id });
    await endTask(task.id, "no Slack channel");
    return { outcome: "disabled", detail: "no Slack channel" };
  }
  const slackChannelId = task.slackChannelId;
  const resolvedDeps = deps ?? (await buildSlackDeps(task.slackTeamId));
  if (!resolvedDeps) {
    console.warn("[scheduler] slack not configured for this workspace; skipping task", {
      taskId: task.id,
      slackTeamId: task.slackTeamId
    });
    return { outcome: "skipped", detail: "Slack is not configured for this workspace" };
  }
  const document = await db.document.findUnique({
    where: { id: task.documentId },
    select: { id: true, title: true, content: true, agentModel: true, agentEffort: true, runnerMode: true }
  });
  if (!document || !task.createdById) {
    const reason = !document ? "document deleted" : "creator deleted";
    await endTask(task.id, reason);
    return { outcome: "disabled", detail: reason };
  }
  const link = await db.slackAccountLink.findFirst({
    where: { slackTeamId: task.slackTeamId, userId: task.createdById },
    select: { slackUserId: true, user: { select: { email: true } } }
  });
  if (!link) {
    const reason = "creator's Slack account is no longer linked";
    await endTask(task.id, reason);
    return { outcome: "disabled", detail: reason };
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
        text: `⏰ Scheduled task: ${task.kind === "wakeup" ? task.instruction.slice(0, 200) : task.title?.trim() || task.instruction.slice(0, 200)}`
      });
  const threadRoot = isThreadContext ? task.slackThreadTs ?? undefined : kickoff.ts ?? undefined;
  const triggerId = threadRoot ? `${slackChannelId}:${threadRoot}` : `${slackChannelId}:scheduled`;

  // One active agent session per Slack thread. If the thread this task fires
  // into is already working, the firing is STEERING for that session, not a
  // second run: stacked runs all park on the per-conversation session lock, so
  // they look hung, never reply, and make follow-up messages unsteerable.
  const instruction = `${firingHeader(task, "set up earlier in this conversation")}\n${task.instruction}`;
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
    return { outcome: "injected", runId: live.steeredRunId };
  }
  if (live.activeRunIds.length > 0) {
    // The thread has an active run we cannot steer (another server process after
    // a deploy, a Codex run, or a zombie the reaper has not collected yet).
    // Starting a second run would stack on the per-conversation session lock, so
    // DEFER the beat instead of dropping it: the claim above already advanced
    // (and, for a one-shot, disabled) this task, so returning here used to lose a
    // check_back_later wake-up forever. Retry shortly — the blocking run either
    // finishes or gets reaped within STALE_AI_RUN_MS.
    if (trigger === "manual") {
      return { outcome: "skipped", detail: "the thread is busy with a run that cannot be steered; try again later" };
    }
    const deferred = await deferBeat(task);
    console.warn("[scheduler] deferring beat: thread has an active run that cannot be steered", {
      taskId: task.id,
      activeRunIds: live.activeRunIds,
      retryAt: deferred?.toISOString() ?? null
    });
    return deferred
      ? { outcome: "deferred", detail: `thread busy; retrying at ${deferred.toISOString()}` }
      : { outcome: "error", detail: "thread stayed busy for more than 30 minutes; this firing was dropped" };
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
  return { outcome: "started", runId: aiRunId };
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
    where: { disabledAt: null, pausedAt: null, nextRunAt: { lte: now } },
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
      where: { id: task.id, nextRunAt: task.nextRunAt, disabledAt: null, pausedAt: null },
      data: {
        lastFiredAt: now,
        ...(next
          ? { nextRunAt: next }
          : { disabledAt: now, endedReason: task.cron ? "invalid cron expression" : "completed" })
      }
    });
    if (claim.count !== 1) continue;
    fired++;
    await fireScheduledTaskWithResult(task, { deps });
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
