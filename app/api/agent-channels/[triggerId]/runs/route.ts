import { NextResponse } from "next/server";

import { resolveAgentApiChannel, resolveChannelPreviousRunId } from "@/lib/agent-api-channels";
import { channelRunMcpServers, channelRunMessageSchema, startAgentChannelRun } from "@/lib/agent-channel-runs";
import { serializeAiRun } from "@/lib/ai-runs";
import { db } from "@/lib/db";
import { McpServerValidationError } from "@/lib/document-mcp-servers";
import { buildRunPermalink } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ triggerId: string }> }) {
  const { triggerId } = await params;
  const channel = await resolveAgentApiChannel(triggerId, request.headers.get("authorization"));
  if (!channel) return NextResponse.json({ error: "Invalid or revoked agent API channel." }, { status: 401 });

  const parsed = channelRunMessageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid agent message payload." }, { status: 400 });

  const message = parsed.data.message.trim();
  const previousRunId = await resolveChannelPreviousRunId(channel, parsed.data.previousRunId ?? null);
  if (previousRunId === undefined) {
    return NextResponse.json({ error: "previousRunId does not belong to this channel." }, { status: 400 });
  }
  let mcpServers;
  try {
    mcpServers = channelRunMcpServers(parsed.data.mcpServers);
  } catch (error) {
    if (error instanceof McpServerValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
  const aiRunId = await startAgentChannelRun({ channel, message, previousRunId, mcpServers });

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
