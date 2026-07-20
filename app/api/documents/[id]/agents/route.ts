import { NextResponse } from "next/server";
import { z } from "zod";

import { recordAiRunEvent, serializeAiRun } from "@/lib/ai-runs";
import { runAgentConversationInBackground } from "@/lib/agent-conversation";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { agentAccessModeForDocumentAccess, canComment, resolveDocumentAccess } from "@/lib/permissions";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const agentConversationSchema = z.object({
  message: z.string().min(1).max(6000),
  shareToken: z.string().optional().nullable(),
  previousRunId: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

// The document-level conversation agent runs off the request path: the HTTP
// handler returns 202 immediately and the client tracks the run (progress, the
// agent reply event, terminal status) via AiRun polling. This avoids the
// Cloudflare ~100s origin timeout (524) on long synchronous conversations.
// The actual background runner is shared with the Slack bot — see
// lib/agent-conversation.ts.
export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const body = await request.json().catch(() => null);
  const parsed = agentConversationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid agent message payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user?.id, parsed.data.shareToken ?? null);
  if (!access || !canComment(access.permission)) {
    return NextResponse.json({ error: "You do not have agent access." }, { status: 403 });
  }

  // Agent runs are expensive; cap how many a single user can kick off per minute.
  const runLimitKey = user ? `ai-run:user:${user.id}` : `ai-run:ip:${getClientIp(request)}`;
  const runLimit = rateLimit(runLimitKey, 10, 60_000);
  if (!runLimit.allowed) {
    return NextResponse.json(
      { error: "You're messaging the agent too quickly. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(runLimit.retryAfterSeconds) } }
    );
  }

  const aiRun = await db.aiRun.create({
    data: {
      documentId: id,
      triggerType: parsed.data.previousRunId ? "CONVERSATION_FOLLOWUP" : "CONVERSATION",
      createdById: user?.id ?? null,
      parentRunId: parsed.data.previousRunId ?? null,
      instruction: parsed.data.message.trim(),
      progress: "Starting Claude research agent.",
      // Conversation runs only ever propose suggestions, never commit content.
      suggestOnly: true
    }
  });
  await recordAiRunEvent({
    aiRunId: aiRun.id,
    role: "user",
    message: parsed.data.message.trim()
  });

  // Kick the agent off in the background and return immediately; the client
  // tracks the run via polling.
  void runAgentConversationInBackground({
    documentId: id,
    aiRunId: aiRun.id,
    message: parsed.data.message.trim(),
    previousRunId: parsed.data.previousRunId ?? null,
    documentTitle: access.document.title,
    documentContent: access.document.content,
    createdById: user?.id ?? null,
    agentConfig: { model: access.document.agentModel, effort: access.document.agentEffort },
    agentAccessMode: agentAccessModeForDocumentAccess(access),
    runnerMode: access.document.runnerMode
  }).catch((error) => {
    console.error("[agents] background run threw", {
      documentId: id,
      aiRunId: aiRun.id,
      error: error instanceof Error ? error.message : error
    });
  });

  const created = await db.aiRun.findUnique({
    where: { id: aiRun.id },
    include: { events: { orderBy: { createdAt: "asc" } } }
  });

  return NextResponse.json(
    { aiRun: created ? serializeAiRun(created) : { id: aiRun.id, status: aiRun.status } },
    { status: 202 }
  );
}
