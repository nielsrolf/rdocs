import { NextResponse } from "next/server";

import { resolveAgentApiChannel } from "@/lib/agent-api-channels";
import { serializeAiRun, summarizeRunUsage } from "@/lib/ai-runs";
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
  // Model calls of the run, the agent's own included: `costUsd` is what providers
  // reported (LiteLLM), `estimatedCostUsd` a list-price figure for calls made directly
  // on an Anthropic credential, hypothetical when `estimatedBilling` is "subscription".
  const settled = run.status === "RUNNING" || run.status === "PENDING" ? [] : [run.id];
  const usage = (await summarizeRunUsage([run.id], new Set(settled))).get(run.id) ?? null;
  return NextResponse.json({
    aiRun: serializeAiRun(run),
    usage,
    runUrl: buildRunPermalink(channel.documentId, run.id)
  });
}
