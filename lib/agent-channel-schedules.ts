// Scheduled runs of a document's AgentApiChannel ("api_channel" ScheduledTask
// rows). The integration that holds the channel token can install standing
// jobs — "every morning, refresh your forecasts" — without any Slack
// installation: the poll loop in lib/scheduler.ts fires them as ordinary
// channel runs (lib/agent-channel-runs.ts), so the integration inspects them
// through the same GET .../runs/:runId it already uses.

import type { ScheduledTask } from "@prisma/client";

import { startAgentChannelRun } from "@/lib/agent-channel-runs";
import { db } from "@/lib/db";
import { computeNextRunAt, MAX_ACTIVE_TASKS_PER_DOCUMENT } from "@/lib/scheduler";

export const API_CHANNEL_CONTEXT = "api_channel";
export const MAX_INSTRUCTION_LENGTH = 6000;

export class ChannelScheduleError extends Error {}

export type ChannelScheduleView = {
  id: string;
  instruction: string;
  cron: string | null;
  timezone: string | null;
  nextRunAt: string;
  lastFiredAt: string | null;
  lastRunId: string | null;
  createdAt: string;
};

function view(task: ScheduledTask): ChannelScheduleView {
  return {
    id: task.id,
    instruction: task.instruction,
    cron: task.cron,
    timezone: task.timezone,
    nextRunAt: task.nextRunAt.toISOString(),
    lastFiredAt: task.lastFiredAt?.toISOString() ?? null,
    lastRunId: task.lastRunId,
    createdAt: task.createdAt.toISOString()
  };
}

export async function listChannelSchedules(documentId: string): Promise<ChannelScheduleView[]> {
  const tasks = await db.scheduledTask.findMany({
    where: { documentId, contextType: API_CHANNEL_CONTEXT, disabledAt: null },
    orderBy: { createdAt: "asc" }
  });
  return tasks.map(view);
}

export async function createChannelSchedule(args: {
  documentId: string;
  createdById: string;
  instruction: string;
  cron?: string | null;
  at?: string | null;
  timezone?: string | null;
}): Promise<ChannelScheduleView> {
  const instruction = args.instruction.trim();
  if (!instruction) throw new ChannelScheduleError("instruction is required.");
  if (instruction.length > MAX_INSTRUCTION_LENGTH) throw new ChannelScheduleError("instruction is too long.");
  let nextRunAt: Date;
  try {
    nextRunAt = computeNextRunAt({ cron: args.cron ?? null, at: args.at ?? null, timezone: args.timezone ?? null });
  } catch (error) {
    throw new ChannelScheduleError(error instanceof Error ? error.message : String(error));
  }
  const active = await db.scheduledTask.count({ where: { documentId: args.documentId, disabledAt: null } });
  if (active >= MAX_ACTIVE_TASKS_PER_DOCUMENT) {
    throw new ChannelScheduleError(`This document already has ${active} active scheduled tasks — cancel some first.`);
  }
  const task = await db.scheduledTask.create({
    data: {
      documentId: args.documentId,
      createdById: args.createdById,
      instruction,
      contextType: API_CHANNEL_CONTEXT,
      cron: args.cron ?? null,
      timezone: args.timezone ?? null,
      nextRunAt
    }
  });
  return view(task);
}

/** Disable one api_channel task of this document. False when there is no such active task. */
export async function cancelChannelSchedule(documentId: string, taskId: string): Promise<boolean> {
  const updated = await db.scheduledTask.updateMany({
    where: { id: taskId, documentId, contextType: API_CHANNEL_CONTEXT, disabledAt: null },
    data: { disabledAt: new Date() }
  });
  return updated.count === 1;
}

export type ApiChannelTaskHooks = {
  startRun?: typeof startAgentChannelRun;
};

/** Fire one claimed api_channel task; returns the run id, or null when the channel is gone. */
export async function fireApiChannelTask(
  task: Pick<ScheduledTask, "id" | "documentId" | "instruction">,
  hooks: ApiChannelTaskHooks = {}
): Promise<string | null> {
  const channel = await db.agentApiChannel.findFirst({
    where: { documentId: task.documentId, revokedAt: null },
    include: { document: true }
  });
  if (!channel) {
    // The token was revoked (or the document deleted): nobody can inspect these
    // runs any more, so the standing job dies with the channel.
    await db.scheduledTask.update({ where: { id: task.id }, data: { disabledAt: new Date() } }).catch(() => null);
    console.warn("[scheduler] disabling api_channel task: its channel is revoked", { taskId: task.id });
    return null;
  }
  const message = `[Scheduled task firing — set up earlier through this channel]\n${task.instruction}`;
  const aiRunId = await (hooks.startRun ?? startAgentChannelRun)({ channel, message });
  await db.scheduledTask.update({ where: { id: task.id }, data: { lastRunId: aiRunId } }).catch(() => null);
  return aiRunId;
}
