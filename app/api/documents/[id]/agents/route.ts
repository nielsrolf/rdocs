import { NextResponse } from "next/server";
import { z } from "zod";

import { recordAiRunEvent, serializeAiRun } from "@/lib/ai-runs";
import { runAgentConversationInBackground } from "@/lib/agent-conversation";
import { resolveAgentConfigForUser } from "@/lib/agent-defaults";
import { rateLimitAiRun, requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { RUN_STARTED_CLAUDE } from "@/agent-core/lifecycle-messages";
import { db } from "@/lib/db";
import { agentAccessModeForDocumentAccess } from "@/lib/permissions";

export const runtime = "nodejs";

const agentConversationSchema = z.object({
  message: z.string().min(1).max(6000),
  shareToken: z.string().optional().nullable(),
  previousRunId: z.string().optional().nullable()
});

// The document-level conversation agent runs off the request path: the HTTP
// handler returns 202 immediately and the client tracks the run (progress, the
// agent reply event, terminal status) via AiRun polling. This avoids the
// Cloudflare ~100s origin timeout (524) on long synchronous conversations.
// The actual background runner is shared with the Slack bot — see
// lib/agent-conversation.ts.
export async function POST(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const parsed = agentConversationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid agent message payload." }, { status: 400 });
  }

  const gate = await requireDocumentAccess(request, id, "COMMENT", {
    shareToken: parsed.data.shareToken ?? null,
    forbiddenMessage: "You do not have agent access."
  });
  if (!gate.ok) {
    return gate.response;
  }
  const { user, access } = gate;

  // Agent runs are expensive; cap how many a single user can kick off per minute.
  const limited = rateLimitAiRun(user, request, "You're messaging the agent too quickly. Try again shortly.");
  if (limited) {
    return limited;
  }

  const aiRun = await db.aiRun.create({
    data: {
      documentId: id,
      triggerType: parsed.data.previousRunId ? "CONVERSATION_FOLLOWUP" : "CONVERSATION",
      createdById: user?.id ?? null,
      parentRunId: parsed.data.previousRunId ?? null,
      instruction: parsed.data.message.trim(),
      progress: RUN_STARTED_CLAUDE,
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
    // Doc agent-panel config -> triggering user's default -> app default.
    agentConfig: await resolveAgentConfigForUser(access.document, user?.id ?? null),
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
