import { NextResponse } from "next/server";

import { resolveAgentApiChannel } from "@/lib/agent-api-channels";
import { serializeAiRun } from "@/lib/ai-runs";
import { db } from "@/lib/db";
import { buildRunPermalink } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ triggerId: string; runId: string }> }
) {
  const { triggerId, runId } = await params;
  const channel = await resolveAgentApiChannel(triggerId, request.headers.get("authorization"));
  if (!channel) return NextResponse.json({ error: "Invalid or revoked agent API channel." }, { status: 401 });

  const run = await db.aiRun.findFirst({
    where: { id: runId, documentId: channel.documentId, triggerId: channel.id },
    include: { events: { orderBy: { createdAt: "asc" } } }
  });
  if (!run) return NextResponse.json({ error: "Run not found for this API channel." }, { status: 404 });
  return NextResponse.json({
    aiRun: serializeAiRun(run),
    runUrl: buildRunPermalink(channel.documentId, run.id)
  });
}
