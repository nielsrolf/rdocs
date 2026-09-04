import { NextResponse } from "next/server";

import { resolveAgentApiChannel } from "@/lib/agent-api-channels";
import { cancelChannelSchedule } from "@/lib/agent-channel-schedules";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ triggerId: string; taskId: string }> }
) {
  const { triggerId, taskId } = await params;
  const channel = await resolveAgentApiChannel(triggerId, request.headers.get("authorization"));
  if (!channel) return NextResponse.json({ error: "Invalid or revoked agent API channel." }, { status: 401 });
  const cancelled = await cancelChannelSchedule(channel.documentId, taskId);
  if (!cancelled) return NextResponse.json({ error: "No active schedule with that id on this channel." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
