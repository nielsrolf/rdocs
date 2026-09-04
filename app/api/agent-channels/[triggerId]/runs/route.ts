import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAgentApiChannel, resolveChannelPreviousRunId } from "@/lib/agent-api-channels";
import { startAgentChannelRun } from "@/lib/agent-channel-runs";
import { serializeAiRun } from "@/lib/ai-runs";
import { db } from "@/lib/db";
import { buildRunPermalink } from "@/lib/request-origin";

export const runtime = "nodejs";

const messageSchema = z.object({
  message: z.string().min(1).max(6000),
  /** Resume the harness session of an earlier run of this channel (same document). */
  previousRunId: z.string().min(1).max(64).optional().nullable()
});

export async function POST(request: Request, { params }: { params: Promise<{ triggerId: string }> }) {
  const { triggerId } = await params;
  const channel = await resolveAgentApiChannel(triggerId, request.headers.get("authorization"));
  if (!channel) return NextResponse.json({ error: "Invalid or revoked agent API channel." }, { status: 401 });

  const parsed = messageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid agent message payload." }, { status: 400 });

  const message = parsed.data.message.trim();
  const previousRunId = await resolveChannelPreviousRunId(channel, parsed.data.previousRunId ?? null);
  if (previousRunId === undefined) {
    return NextResponse.json({ error: "previousRunId does not belong to this channel." }, { status: 400 });
  }
  const aiRunId = await startAgentChannelRun({ channel, message, previousRunId });

  const created = await db.aiRun.findUnique({
    where: { id: aiRunId },
    include: { events: { orderBy: { createdAt: "asc" } } }
  });
  return NextResponse.json({
    aiRun: created ? serializeAiRun(created) : { id: aiRunId, status: "PENDING" },
    runUrl: buildRunPermalink(channel.documentId, aiRunId),
    statusUrl: `/api/agent-channels/${triggerId}/runs/${aiRunId}`
  }, { status: 202 });
}
