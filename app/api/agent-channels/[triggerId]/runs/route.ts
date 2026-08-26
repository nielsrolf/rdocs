import { NextResponse } from "next/server";
import { z } from "zod";

import { RUN_STARTED_CLAUDE } from "@/agent-core/lifecycle-messages";
import { resolveAgentConfigForUser } from "@/lib/agent-defaults";
import { resolveAgentApiChannel } from "@/lib/agent-api-channels";
import { runAgentConversationInBackground } from "@/lib/agent-conversation";
import { recordAiRunEvent, serializeAiRun } from "@/lib/ai-runs";
import { db } from "@/lib/db";
import { buildRunPermalink } from "@/lib/request-origin";

export const runtime = "nodejs";

const messageSchema = z.object({ message: z.string().min(1).max(6000) });

export async function POST(request: Request, { params }: { params: Promise<{ triggerId: string }> }) {
  const { triggerId } = await params;
  const channel = await resolveAgentApiChannel(triggerId, request.headers.get("authorization"));
  if (!channel) return NextResponse.json({ error: "Invalid or revoked agent API channel." }, { status: 401 });

  const parsed = messageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid agent message payload." }, { status: 400 });

  const message = parsed.data.message.trim();
  const aiRun = await db.aiRun.create({
    data: {
      documentId: channel.documentId,
      triggerType: "API",
      triggerId: channel.id,
      createdById: channel.createdById,
      instruction: message,
      progress: RUN_STARTED_CLAUDE,
      suggestOnly: true
    }
  });
  await recordAiRunEvent({ aiRunId: aiRun.id, role: "user", message });

  void runAgentConversationInBackground({
    documentId: channel.documentId,
    aiRunId: aiRun.id,
    message,
    previousRunId: null,
    documentTitle: channel.document.title,
    documentContent: channel.document.content,
    createdById: channel.createdById,
    agentConfig: await resolveAgentConfigForUser(channel.document, channel.createdById),
    agentAccessMode: "workspace",
    runnerMode: channel.document.runnerMode
  }).catch((error) => {
    console.error("[agent-api] background run threw", {
      triggerId,
      aiRunId: aiRun.id,
      error: error instanceof Error ? error.message : error
    });
  });

  const created = await db.aiRun.findUnique({
    where: { id: aiRun.id },
    include: { events: { orderBy: { createdAt: "asc" } } }
  });
  return NextResponse.json({
    aiRun: created ? serializeAiRun(created) : { id: aiRun.id, status: aiRun.status },
    runUrl: buildRunPermalink(channel.documentId, aiRun.id),
    statusUrl: `/api/agent-channels/${triggerId}/runs/${aiRun.id}`
  }, { status: 202 });
}
