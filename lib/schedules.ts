// One service for every ScheduledTask, whichever surface created it.
//
// Scheduled tasks are created from four places — claudex's Slack tools
// (lib/slack/agent-tools.ts), the MCP bridge (lib/document-schedules.ts), the
// API-channel REST endpoint that forecasting uses (lib/agent-channel-schedules.ts)
// and the Schedules UI — and they all land in the one ScheduledTask table that
// the poll loop in lib/scheduler.ts fires. Each surface used to carry its own
// list/cancel queries and rules, so nobody could see the whole picture. This
// module is the shared layer: the overview, the permission rule, edit / pause /
// resume / cancel / run-now, and the firing log.
//
// Permission rule: a task is visible to and manageable by its creator (it runs
// with their credentials) and by anyone with EDIT access to its document. The
// surfaces may add their own extra grant on top (e.g. any member of a shared
// Slack channel may cancel from Slack) by passing `authorized: true`.

import type { Prisma, ScheduledTask } from "@prisma/client";
import { CronExpressionParser } from "cron-parser";

import { db } from "@/lib/db";
import { listAccessibleDocumentsForUser } from "@/lib/document-data";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";

export const SCHEDULE_KINDS = ["job", "wakeup"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export const FIRING_OUTCOMES = ["started", "injected", "deferred", "skipped", "disabled", "error"] as const;
export type FiringOutcome = (typeof FIRING_OUTCOMES)[number];

export type FiringResult = {
  outcome: FiringOutcome;
  runId?: string | null;
  detail?: string | null;
};

export const MIN_RECURRENCE_MS = 5 * 60 * 1000;
export const MAX_ACTIVE_TASKS_PER_DOCUMENT = 20;
export const MAX_TITLE_LENGTH = 80;
export const MAX_SCHEDULE_INSTRUCTION_LENGTH = 6000;

export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Timing

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
  if (input.timezone && !isValidTimezone(input.timezone)) {
    throw new Error(`Unknown timezone: ${input.timezone}. Use an IANA name such as Europe/Berlin.`);
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

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The next `count` firing times of a cron expression (for the edit form's preview). */
export function previewNextRuns(cron: string, timezone: string | null | undefined, count = 3, from = new Date()) {
  const expression = CronExpressionParser.parse(cron, { currentDate: from, ...(timezone ? { tz: timezone } : {}) });
  return Array.from({ length: count }, () => expression.next().toDate());
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pad(value: string) {
  return value.padStart(2, "0");
}

/**
 * Plain-words rendering of the common cron shapes ("Daily at 08:00",
 * "Weekdays at 09:30", "Mondays at 07:00", "Hourly at :15", "Every 30 minutes").
 * Anything else falls back to the raw expression.
 */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return `cron ${cron}`;
  const [minute, hour, dom, month, dow] = parts;
  const isNum = (value: string) => /^\d+$/.test(value);
  if (dom === "*" && month === "*") {
    if (isNum(minute) && isNum(hour)) {
      const time = `${pad(hour)}:${pad(minute)}`;
      if (dow === "*") return `Daily at ${time}`;
      if (dow === "1-5") return `Weekdays at ${time}`;
      if (dow === "0,6" || dow === "6,0") return `Weekends at ${time}`;
      if (isNum(dow)) return `${WEEKDAYS[Number(dow) % 7]}s at ${time}`;
      if (/^\d(,\d)+$/.test(dow)) {
        return `${dow
          .split(",")
          .map((d) => WEEKDAYS[Number(d) % 7].slice(0, 3))
          .join(", ")} at ${time}`;
      }
    }
    if (isNum(minute) && hour === "*" && dow === "*") return `Hourly at :${pad(minute)}`;
    const everyMinutes = /^\*\/(\d+)$/.exec(minute);
    if (everyMinutes && hour === "*" && dow === "*") return `Every ${everyMinutes[1]} minutes`;
    const everyHours = /^\*\/(\d+)$/.exec(hour);
    if (isNum(minute) && everyHours && dow === "*") return `Every ${everyHours[1]} hours at :${pad(minute)}`;
  }
  if (isNum(minute) && isNum(hour) && isNum(dom) && month === "*" && dow === "*") {
    return `Monthly on day ${dom} at ${pad(hour)}:${pad(minute)}`;
  }
  return `cron ${cron}`;
}

export function describeSchedule(task: Pick<ScheduledTask, "cron" | "timezone" | "nextRunAt">): string {
  if (!task.cron) return `Once, ${task.nextRunAt.toISOString().replace("T", " ").slice(0, 16)} UTC`;
  return `${describeCron(task.cron)}${task.timezone ? ` (${task.timezone})` : " (UTC)"}`;
}

/** First line of the instruction, trimmed to a title-sized label. */
export function defaultTitle(instruction: string): string {
  const firstLine =
    instruction
      .split("\n")
      .map((line) => line.replace(/^\[[^\]]*\]\s*/, "").trim())
      .find((line) => line.length > 0) ?? "Scheduled task";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine;
}

export function normalizeTitle(title: string | null | undefined, instruction: string): string {
  const trimmed = title?.trim();
  if (trimmed) return trimmed.slice(0, MAX_TITLE_LENGTH);
  return defaultTitle(instruction);
}

/**
 * First line of every firing message: names the task so the agent knows which
 * standing job woke it, and tells it how to change that job instead of piling a
 * duplicate on top. Wake-ups (check_back_later) carry their own framing.
 */
export function firingHeader(
  task: { id: string; title?: string | null; instruction: string; kind?: string | null },
  origin: string
): string {
  if (task.kind === "wakeup") return `[Scheduled task firing — ${origin}]`;
  const title = task.title?.trim() || defaultTitle(task.instruction);
  return (
    `[Scheduled task firing — "${title}" (id ${task.id}), ${origin}. ` +
    `To change, pause or cancel this standing job, use update_scheduled_task / cancel_scheduled_task with that id.]`
  );
}

// ---------------------------------------------------------------------------
// Creation helpers shared by every surface

/** Validate timing and capacity, returning the first firing time. Throws ScheduleError. */
export async function prepareNewSchedule(args: {
  documentId: string;
  cron?: string | null;
  at?: string | null;
  timezone?: string | null;
}): Promise<Date> {
  let nextRunAt: Date;
  try {
    nextRunAt = computeNextRunAt({ cron: args.cron ?? null, at: args.at ?? null, timezone: args.timezone ?? null });
  } catch (error) {
    throw new ScheduleError(error instanceof Error ? error.message : String(error));
  }
  const active = await db.scheduledTask.count({ where: { documentId: args.documentId, disabledAt: null } });
  if (active >= MAX_ACTIVE_TASKS_PER_DOCUMENT) {
    throw new ScheduleError(`This document already has ${active} active scheduled tasks — cancel some first.`);
  }
  return nextRunAt;
}

// ---------------------------------------------------------------------------
// The firing log

/** Record one firing attempt and mirror it onto the task. Never throws. */
export async function recordFiring(
  taskId: string,
  result: FiringResult & { trigger?: "schedule" | "manual" }
): Promise<void> {
  const detail = result.detail ? result.detail.slice(0, 1000) : null;
  await db
    .$transaction([
      db.scheduledTaskFiring.create({
        data: {
          taskId,
          outcome: result.outcome,
          trigger: result.trigger ?? "schedule",
          runId: result.runId ?? null,
          detail
        }
      }),
      db.scheduledTask.update({
        where: { id: taskId },
        data: {
          lastOutcome: result.outcome,
          lastError: result.outcome === "error" || result.outcome === "disabled" ? detail : null,
          ...(result.runId ? { lastRunId: result.runId } : {})
        }
      })
    ])
    .catch((error) => {
      console.error("[scheduler] could not record firing", {
        taskId,
        outcome: result.outcome,
        error: error instanceof Error ? error.message : error
      });
    });
}

/** End a task for good (it will never fire again). */
export async function endTask(taskId: string, reason: string): Promise<void> {
  await db.scheduledTask
    .updateMany({ where: { id: taskId, disabledAt: null }, data: { disabledAt: new Date(), endedReason: reason } })
    .catch(() => null);
}

// ---------------------------------------------------------------------------
// Overview

export type ScheduleStatus = "active" | "paused" | "ended";

export type ScheduleView = {
  id: string;
  title: string;
  kind: string;
  context: string;
  instruction: string;
  cron: string | null;
  timezone: string | null;
  schedule: string;
  status: ScheduleStatus;
  endedReason: string | null;
  endedAt: string | null;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  lastRunId: string | null;
  lastOutcome: string | null;
  lastError: string | null;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  document: { id: string; title: string; kind: string };
  slack: { teamId: string; channelId: string; threadTs: string | null; url: string } | null;
  // Path in this app that shows the task (the Schedules tab, scrolled to it).
  link: string;
  canManage: boolean;
};

const taskInclude = {
  createdBy: { select: { id: true, name: true } },
  document: { select: { id: true, title: true, kind: true } }
} satisfies Prisma.ScheduledTaskInclude;

type TaskWithRelations = Prisma.ScheduledTaskGetPayload<{ include: typeof taskInclude }>;

export function scheduleStatus(task: Pick<ScheduledTask, "disabledAt" | "pausedAt">): ScheduleStatus {
  if (task.disabledAt) return "ended";
  if (task.pausedAt) return "paused";
  return "active";
}

export function scheduleLink(taskId: string) {
  return `/dashboard?tab=schedules#schedule-${taskId}`;
}

function slackUrl(teamId: string, channelId: string, threadTs: string | null) {
  // app.slack.com deep links open the right workspace in the browser or app.
  const base = `https://app.slack.com/client/${teamId}/${channelId}`;
  return threadTs ? `${base}/thread/${channelId}-${threadTs}` : base;
}

function toView(task: TaskWithRelations, canManage: boolean): ScheduleView {
  const status = scheduleStatus(task);
  return {
    id: task.id,
    title: task.title?.trim() || defaultTitle(task.instruction),
    kind: task.kind,
    context: task.contextType,
    instruction: task.instruction,
    cron: task.cron,
    timezone: task.timezone,
    schedule: describeSchedule(task),
    status,
    endedReason: task.endedReason,
    endedAt: task.disabledAt?.toISOString() ?? null,
    nextRunAt: status === "active" ? task.nextRunAt.toISOString() : null,
    lastFiredAt: task.lastFiredAt?.toISOString() ?? null,
    lastRunId: task.lastRunId,
    lastOutcome: task.lastOutcome,
    lastError: task.lastError,
    createdAt: task.createdAt.toISOString(),
    createdBy: task.createdBy ? { id: task.createdBy.id, name: task.createdBy.name } : null,
    document: { id: task.document.id, title: task.document.title, kind: task.document.kind },
    slack:
      task.slackTeamId && task.slackChannelId
        ? {
            teamId: task.slackTeamId,
            channelId: task.slackChannelId,
            threadTs: task.slackThreadTs,
            url: slackUrl(task.slackTeamId, task.slackChannelId, task.slackThreadTs)
          }
        : null,
    link: scheduleLink(task.id),
    canManage
  };
}

async function editableDocumentIds(userId: string): Promise<Set<string>> {
  const documents = await listAccessibleDocumentsForUser(userId);
  return new Set(documents.filter((d) => d.permission === "EDIT").map((d) => d.id));
}

export type ListSchedulesOptions = {
  /** Restrict to one document. */
  documentId?: string;
  /** Include ended tasks (cancelled, finished one-shots). Default false. */
  includeEnded?: boolean;
  /** Include agents' check_back_later wake-ups. Default false. */
  includeWakeups?: boolean;
  /** Only tasks this user created. */
  createdByOnly?: boolean;
  limit?: number;
};

/** Every task the user may see: ones they created, plus all tasks on documents they can edit. */
export async function listSchedulesForUser(userId: string, options: ListSchedulesOptions = {}): Promise<ScheduleView[]> {
  const editable = await editableDocumentIds(userId);
  const visibility: Prisma.ScheduledTaskWhereInput = options.createdByOnly
    ? { createdById: userId }
    : { OR: [{ createdById: userId }, { documentId: { in: [...editable] } }] };
  const tasks = await db.scheduledTask.findMany({
    where: {
      AND: [
        visibility,
        options.documentId ? { documentId: options.documentId } : {},
        options.includeEnded ? {} : { disabledAt: null },
        options.includeWakeups ? {} : { kind: { not: "wakeup" } }
      ]
    },
    include: taskInclude,
    orderBy: [{ disabledAt: "asc" }, { nextRunAt: "asc" }],
    take: Math.min(options.limit ?? 200, 500)
  });
  return tasks.map((task) => toView(task, task.createdById === userId || editable.has(task.documentId)));
}

/** Every task of one document, as seen by surfaces that already checked document access. */
export async function listSchedulesForDocument(
  documentId: string,
  options: { includeEnded?: boolean; includeWakeups?: boolean; contexts?: string[] } = {}
): Promise<ScheduleView[]> {
  const tasks = await db.scheduledTask.findMany({
    where: {
      documentId,
      ...(options.contexts ? { contextType: { in: options.contexts } } : {}),
      ...(options.includeEnded ? {} : { disabledAt: null }),
      ...(options.includeWakeups ? {} : { kind: { not: "wakeup" } })
    },
    include: taskInclude,
    orderBy: [{ disabledAt: "asc" }, { nextRunAt: "asc" }]
  });
  return tasks.map((task) => toView(task, true));
}

export async function canManageSchedule(
  task: Pick<ScheduledTask, "createdById" | "documentId">,
  userId: string
): Promise<boolean> {
  if (task.createdById === userId) return true;
  const access = await resolveDocumentAccess(task.documentId, userId, null);
  return Boolean(access && canEdit(access.permission));
}

async function loadTask(taskId: string): Promise<TaskWithRelations> {
  const task = await db.scheduledTask.findUnique({ where: { id: taskId }, include: taskInclude });
  if (!task) throw new ScheduleError("No scheduled task with that id.", 404);
  return task;
}

export type ScheduleActor = {
  userId: string | null;
  /** The calling surface already authorized this change by its own rule. */
  authorized?: boolean;
};

async function authorize(task: TaskWithRelations, actor: ScheduleActor) {
  if (actor.authorized) return;
  if (!actor.userId || !(await canManageSchedule(task, actor.userId))) {
    // Do not reveal whether the id exists to someone who cannot see it.
    throw new ScheduleError("No scheduled task with that id that you can manage.", 404);
  }
}

export async function getScheduleForUser(taskId: string, userId: string): Promise<ScheduleView> {
  const task = await loadTask(taskId);
  await authorize(task, { userId });
  return toView(task, true);
}

export type FiringView = {
  id: string;
  firedAt: string;
  outcome: string;
  trigger: string;
  runId: string | null;
  runStatus: string | null;
  detail: string | null;
};

export async function getScheduleHistory(taskId: string, actor: ScheduleActor, limit = 20): Promise<FiringView[]> {
  const task = await loadTask(taskId);
  await authorize(task, actor);
  const firings = await db.scheduledTaskFiring.findMany({
    where: { taskId },
    orderBy: { firedAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100)
  });
  const runIds = firings.map((f) => f.runId).filter((id): id is string => Boolean(id));
  const runs = runIds.length
    ? await db.aiRun.findMany({ where: { id: { in: runIds } }, select: { id: true, status: true } })
    : [];
  const statusById = new Map(runs.map((run) => [run.id, run.status as string]));
  return firings.map((firing) => ({
    id: firing.id,
    firedAt: firing.firedAt.toISOString(),
    outcome: firing.outcome,
    trigger: firing.trigger,
    runId: firing.runId,
    runStatus: firing.runId ? statusById.get(firing.runId) ?? null : null,
    detail: firing.detail
  }));
}

/** The task a run was fired by, if any (for the run timeline badge). */
export async function scheduleForRun(runId: string): Promise<{ id: string; title: string } | null> {
  const firing = await db.scheduledTaskFiring.findFirst({
    where: { runId },
    orderBy: { firedAt: "desc" },
    select: { task: { select: { id: true, title: true, instruction: true } } }
  });
  if (!firing) return null;
  return { id: firing.task.id, title: firing.task.title?.trim() || defaultTitle(firing.task.instruction) };
}

// ---------------------------------------------------------------------------
// Mutations

export type SchedulePatch = {
  title?: string | null;
  instruction?: string;
  /** New recurrence. Pass cron (with optional timezone) or at, not both. */
  cron?: string | null;
  at?: string | null;
  timezone?: string | null;
  paused?: boolean;
};

export async function updateSchedule(taskId: string, patch: SchedulePatch, actor: ScheduleActor): Promise<ScheduleView> {
  const task = await loadTask(taskId);
  await authorize(task, actor);
  if (task.disabledAt) throw new ScheduleError("This task has ended; create a new one instead.");
  if (task.kind === "wakeup" && (patch.cron !== undefined || patch.paused !== undefined)) {
    throw new ScheduleError("A check_back_later wake-up can only be cancelled or have its time changed.");
  }

  const data: Prisma.ScheduledTaskUpdateInput = {};
  if (patch.title !== undefined) {
    data.title = patch.title === null ? null : patch.title.trim().slice(0, MAX_TITLE_LENGTH) || null;
  }
  if (patch.instruction !== undefined) {
    const instruction = patch.instruction.trim();
    if (!instruction) throw new ScheduleError("instruction must not be empty.");
    if (instruction.length > MAX_SCHEDULE_INSTRUCTION_LENGTH) throw new ScheduleError("instruction is too long.");
    data.instruction = instruction;
  }

  const timingChanged = patch.cron !== undefined || patch.at !== undefined || patch.timezone !== undefined;
  let cron = task.cron;
  let timezone = task.timezone;
  if (timingChanged) {
    if (patch.at) {
      cron = null;
    } else if (patch.cron !== undefined && patch.cron !== null) {
      cron = patch.cron.trim();
    }
    if (patch.timezone !== undefined) timezone = patch.timezone?.trim() || null;
    if (!cron && !patch.at) {
      throw new ScheduleError("A one-shot task needs a new `at` time to be rescheduled.");
    }
    try {
      data.nextRunAt = computeNextRunAt({ cron, at: cron ? null : patch.at ?? null, timezone });
    } catch (error) {
      throw new ScheduleError(error instanceof Error ? error.message : String(error));
    }
    data.cron = cron;
    data.timezone = timezone;
  }

  if (patch.paused === true && !task.pausedAt) {
    if (!cron) throw new ScheduleError("Only recurring tasks can be paused; cancel a one-shot instead.");
    data.pausedAt = new Date();
  } else if (patch.paused === false && task.pausedAt) {
    data.pausedAt = null;
    // Missed occurrences are not backfilled: resume from now.
    if (!data.nextRunAt && cron) data.nextRunAt = computeNextRunAt({ cron, timezone });
  }

  await db.scheduledTask.update({ where: { id: taskId }, data });
  const updated = await loadTask(taskId);
  console.log("[scheduler] task updated", { taskId, by: actor.userId, fields: Object.keys(data) });
  return toView(updated, true);
}

export async function cancelSchedule(taskId: string, actor: ScheduleActor): Promise<ScheduleView> {
  const task = await loadTask(taskId);
  await authorize(task, actor);
  if (task.disabledAt) throw new ScheduleError("This task has already ended.");
  await endTask(taskId, "cancelled");
  console.log("[scheduler] task cancelled", { taskId, by: actor.userId });
  return toView(await loadTask(taskId), true);
}

/**
 * Fire a task once, right now, without touching its schedule. The firing is
 * logged with trigger "manual". Returns the run id when one started.
 */
export async function runScheduleNow(
  taskId: string,
  actor: ScheduleActor,
  options: Omit<NonNullable<Parameters<typeof import("@/lib/scheduler").fireScheduledTaskWithResult>[1]>, "trigger"> = {}
): Promise<FiringResult> {
  const task = await loadTask(taskId);
  await authorize(task, actor);
  if (task.disabledAt) throw new ScheduleError("This task has ended.");
  const { fireScheduledTaskWithResult } = await import("@/lib/scheduler");
  return fireScheduledTaskWithResult(task, { ...options, trigger: "manual" });
}
