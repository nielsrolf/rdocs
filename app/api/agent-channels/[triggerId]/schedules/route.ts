import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAgentApiChannel } from "@/lib/agent-api-channels";
import {
  ChannelScheduleError,
  createChannelSchedule,
  listChannelSchedules,
  MAX_INSTRUCTION_LENGTH
} from "@/lib/agent-channel-schedules";

export const runtime = "nodejs";

// Standing jobs for a document agent, installed by the integration that holds
// the channel token. Each firing is a normal channel run (inspect it via
// GET .../runs/:runId, the run id is `lastRunId` in the listing).
export async function GET(request: Request, { params }: { params: Promise<{ triggerId: string }> }) {
  const { triggerId } = await params;
  const channel = await resolveAgentApiChannel(triggerId, request.headers.get("authorization"));
  if (!channel) return NextResponse.json({ error: "Invalid or revoked agent API channel." }, { status: 401 });
  return NextResponse.json({ schedules: await listChannelSchedules(channel.documentId) });
}

const createSchema = z.object({
  instruction: z.string().min(1).max(MAX_INSTRUCTION_LENGTH),
  /** 5-field cron for a recurring job … */
  cron: z.string().min(9).max(100).optional().nullable(),
  /** … or an ISO-8601 time for a one-shot. Exactly one of the two. */
  at: z.string().min(10).max(40).optional().nullable(),
  timezone: z.string().min(1).max(64).optional().nullable()
});

export async function POST(request: Request, { params }: { params: Promise<{ triggerId: string }> }) {
  const { triggerId } = await params;
  const channel = await resolveAgentApiChannel(triggerId, request.headers.get("authorization"));
  if (!channel) return NextResponse.json({ error: "Invalid or revoked agent API channel." }, { status: 401 });
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid schedule payload." }, { status: 400 });
  try {
    const schedule = await createChannelSchedule({
      documentId: channel.documentId,
      createdById: channel.createdById,
      ...parsed.data
    });
    return NextResponse.json({ schedule }, { status: 201 });
  } catch (error) {
    if (error instanceof ChannelScheduleError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
