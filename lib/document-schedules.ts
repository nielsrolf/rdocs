// Scheduled runs of a DOCUMENT ("document" ScheduledTask rows): standing jobs
// like "every morning, refresh this dashboard" that need neither Slack nor an
// API channel. They are installed through the MCP bridge (schedule_task on
// /api/mcp) by anyone with edit access, and each firing is a headless
// conversation run as the scheduler, with the document bridge mounted so its
// edits are applied server-side (lib/document-run-token.ts).

import type { ScheduledTask } from "@prisma/client";

import { RUN_STARTED_CLAUDE } from "@/agent-core/lifecycle-messages";
import { resolveAgentConfigForUser } from "@/lib/agent-defaults";
import { runAgentConversationInBackground } from "@/lib/agent-conversation";
import { recordAiRunEvent } from "@/lib/ai-runs";
import { db } from "@/lib/db";
import { headlessEditNote, withDocumentBridge } from "@/lib/document-run-token";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";
import { computeNextRunAt, MAX_ACTIVE_TASKS_PER_DOCUMENT } from "@/lib/scheduler";

export const DOCUMENT_CONTEXT = "document";
export const SCHEDULED_TRIGGER_TYPE = "SCHEDULED";
export const MAX_DOCUMENT_INSTRUCTION_LENGTH = 6000;

export class DocumentScheduleError extends Error {}

export type DocumentScheduleView = {
  id: string;
  instruction: string;
  cron: string | null;
  timezone: string | null;
  nextRunAt: string;
  lastFiredAt: string | null;
  lastRunId: string | null;
  createdById: string | null;
  createdAt: string;
};

function view(task: ScheduledTask): DocumentScheduleView {
  return {
    id: task.id,
    instruction: task.instruction,
    cron: task.cron,
    timezone: task.timezone,
    nextRunAt: task.nextRunAt.toISOString(),
    lastFiredAt: task.lastFiredAt?.toISOString() ?? null,
    lastRunId: task.lastRunId,
    createdById: task.createdById,
    createdAt: task.createdAt.toISOString()
  };
}

export async function listDocumentSchedules(documentId: string): Promise<DocumentScheduleView[]> {
  const tasks = await db.scheduledTask.findMany({
    where: { documentId, contextType: DOCUMENT_CONTEXT, disabledAt: null },
    orderBy: { createdAt: "asc" }
  });
  return tasks.map(view);
}

export async function createDocumentSchedule(args: {
  documentId: string;
  createdById: string;
  instruction: string;
  cron?: string | null;
  at?: string | null;
  timezone?: string | null;
}): Promise<DocumentScheduleView> {
  const instruction = args.instruction.trim();
  if (!instruction) throw new DocumentScheduleError("instruction is required.");
  if (instruction.length > MAX_DOCUMENT_INSTRUCTION_LENGTH) {
    throw new DocumentScheduleError("instruction is too long.");
  }
  let nextRunAt: Date;
  try {
    nextRunAt = computeNextRunAt({ cron: args.cron ?? null, at: args.at ?? null, timezone: args.timezone ?? null });
  } catch (error) {
    throw new DocumentScheduleError(error instanceof Error ? error.message : String(error));
  }
  const active = await db.scheduledTask.count({ where: { documentId: args.documentId, disabledAt: null } });
  if (active >= MAX_ACTIVE_TASKS_PER_DOCUMENT) {
    throw new DocumentScheduleError(`This document already has ${active} active scheduled tasks — cancel some first.`);
  }
  const task = await db.scheduledTask.create({
    data: {
      documentId: args.documentId,
      createdById: args.createdById,
      instruction,
      contextType: DOCUMENT_CONTEXT,
      cron: args.cron ?? null,
      timezone: args.timezone ?? null,
      nextRunAt
    }
  });
  return view(task);
}

/** Disable one document task. False when there is no such active task. */
export async function cancelDocumentSchedule(documentId: string, taskId: string): Promise<boolean> {
  const updated = await db.scheduledTask.updateMany({
    where: { id: taskId, documentId, contextType: DOCUMENT_CONTEXT, disabledAt: null },
    data: { disabledAt: new Date() }
  });
  return updated.count === 1;
}

export type DocumentTaskHooks = {
  runInBackground?: typeof runAgentConversationInBackground;
};

async function disable(taskId: string, reason: string) {
  await db.scheduledTask.update({ where: { id: taskId }, data: { disabledAt: new Date() } }).catch(() => null);
  console.warn(`[scheduler] disabling document task: ${reason}`, { taskId });
}

/**
 * Fire one claimed document task as a headless run of its scheduler. Returns
 * the run id, or null when the task can no longer run (document gone, or the
 * scheduler lost edit access) — such a task is disabled, not retried.
 */
export async function fireDocumentTask(
  task: Pick<ScheduledTask, "id" | "documentId" | "instruction" | "createdById">,
  hooks: DocumentTaskHooks = {}
): Promise<string | null> {
  if (!task.createdById) {
    await disable(task.id, "its scheduler was deleted");
    return null;
  }
  const access = await resolveDocumentAccess(task.documentId, task.createdById, null);
  if (!access || !canEdit(access.permission)) {
    await disable(task.id, "its scheduler no longer has edit access");
    return null;
  }
  const document = access.document;
  const instruction = `[Scheduled task firing — standing job on this document]\n${task.instruction}`;
  const aiRun = await db.aiRun.create({
    data: {
      documentId: task.documentId,
      triggerType: SCHEDULED_TRIGGER_TYPE,
      triggerId: `schedule:${task.id}`,
      createdById: task.createdById,
      instruction,
      progress: RUN_STARTED_CLAUDE,
      suggestOnly: true
    }
  });
  await recordAiRunEvent({ aiRunId: aiRun.id, role: "user", message: instruction });
  const mcpServers = await withDocumentBridge(undefined, {
    userId: task.createdById,
    documentId: task.documentId,
    aiRunId: aiRun.id
  });
  void (hooks.runInBackground ?? runAgentConversationInBackground)({
    documentId: task.documentId,
    aiRunId: aiRun.id,
    message: `${headlessEditNote(task.documentId)}\n\n${instruction}`,
    previousRunId: null,
    documentTitle: document.title,
    documentContent: document.content,
    createdById: task.createdById,
    agentConfig: await resolveAgentConfigForUser(document, task.createdById),
    agentAccessMode: "workspace",
    runnerMode: document.runnerMode,
    mcpServers
  }).catch((error) => {
    console.error("[scheduler] document task run threw", {
      taskId: task.id,
      aiRunId: aiRun.id,
      error: error instanceof Error ? error.message : error
    });
  });
  await db.scheduledTask.update({ where: { id: task.id }, data: { lastRunId: aiRun.id } }).catch(() => null);
  return aiRun.id;
}
