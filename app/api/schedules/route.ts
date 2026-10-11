import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { createDocumentSchedule, DocumentScheduleError } from "@/lib/document-schedules";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";
import {
  describeCron,
  listSchedulesForUser,
  MAX_SCHEDULE_INSTRUCTION_LENGTH,
  MAX_TITLE_LENGTH,
  normalizeTitle,
  prepareNewSchedule,
  scheduleLink,
  ScheduleError
} from "@/lib/schedules";
import { slackTeamContext } from "@/lib/slack/installations";

export const runtime = "nodejs";

// The Schedules overview (dashboard tab + per-document menu): every scheduled
// task the signed-in user can see — ones they created and ones on documents they
// can edit — whichever surface created it (lib/schedules.ts).
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const url = new URL(request.url);
  const flag = (name: string) => url.searchParams.get(name) === "1" || url.searchParams.get(name) === "true";
  const schedules = await listSchedulesForUser(user.id, {
    documentId: url.searchParams.get("documentId") || undefined,
    includeEnded: flag("includeEnded"),
    includeWakeups: flag("includeWakeups")
  });
  return NextResponse.json({ schedules });
}

const createSchema = z.object({
  documentId: z.string().min(1),
  title: z.string().max(MAX_TITLE_LENGTH).optional().nullable(),
  instruction: z.string().min(1).max(MAX_SCHEDULE_INSTRUCTION_LENGTH),
  cron: z.string().min(9).max(100).optional().nullable(),
  at: z.string().min(10).max(40).optional().nullable(),
  timezone: z.string().min(1).max(64).optional().nullable(),
  // "document": a headless agent run on the document that edits it directly.
  // "slack_channel": a claudex run in the document's Slack channel, posting a
  // new thread per firing (only for Slack channel workspaces).
  target: z.enum(["document", "slack_channel"]).default("document")
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid schedule." }, { status: 400 });
  const input = parsed.data;

  const access = await resolveDocumentAccess(input.documentId, user.id, null);
  if (!access || !canEdit(access.permission)) {
    return NextResponse.json({ error: "You need edit access to schedule tasks on this document." }, { status: 403 });
  }

  try {
    if (input.target === "document") {
      const schedule = await createDocumentSchedule({ ...input, createdById: user.id });
      return NextResponse.json({ schedule }, { status: 201 });
    }

    const document = await db.document.findUnique({
      where: { id: input.documentId },
      select: { kind: true, slackTeamId: true, slackChannelId: true }
    });
    if (document?.kind !== "slack_channel" || !document.slackTeamId || !document.slackChannelId) {
      return NextResponse.json({ error: "Only Slack channel workspaces can post into Slack." }, { status: 400 });
    }
    // The firing runs as the creator's Slack identity, exactly like a task
    // claudex schedules from Slack.
    const link = await db.slackAccountLink.findFirst({
      where: { slackTeamId: document.slackTeamId, userId: user.id },
      select: { id: true }
    });
    if (!link) {
      return NextResponse.json(
        { error: "Link your Slack account in this workspace first (send claudex a DM)." },
        { status: 400 }
      );
    }
    const nextRunAt = await prepareNewSchedule(input);
    const instruction = input.instruction.trim();
    const title = normalizeTitle(input.title, instruction);
    const task = await db.scheduledTask.create({
      data: {
        documentId: input.documentId,
        createdById: user.id,
        title,
        kind: "job",
        instruction,
        contextType: "slack_channel",
        slackTeamId: document.slackTeamId,
        slackChannelId: document.slackChannelId,
        cron: input.cron ?? null,
        timezone: input.timezone ?? null,
        nextRunAt
      }
    });
    // Same visible consent as schedule_task from Slack: in a shared channel,
    // members learn the task exists, who it runs as and how to stop it.
    if (!document.slackChannelId.startsWith("D")) {
      const team = await slackTeamContext(document.slackTeamId);
      const when = input.cron ? describeCron(input.cron) + (input.timezone ? ` (${input.timezone})` : " (UTC)") : "Runs once";
      await team?.slack
        .postMessage({
          channel: document.slackChannelId,
          text:
            `⏰ ${user.name} scheduled a task here (id ${task.id}): "${title}"\n` +
            `${when} — next firing ${nextRunAt.toISOString()}. It runs with ${user.name}'s credentials. ` +
            `Anyone in this channel can cancel it (ask the bot to cancel scheduled task ${task.id}).`
        })
        .catch(() => null);
    }
    return NextResponse.json({ schedule: { id: task.id, link: scheduleLink(task.id) } }, { status: 201 });
  } catch (error) {
    if (error instanceof ScheduleError || error instanceof DocumentScheduleError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
