import { NextResponse } from "next/server";
import { z } from "zod";

import { recordAiRunEvent } from "@/lib/ai-runs";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { agentAccessModeForDocumentAccess, canComment, resolveDocumentAccess } from "@/lib/permissions";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { runAskAiInBackground } from "@/lib/ask-ai";

export const runtime = "nodejs";

const askAiSchema = z.object({
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    threadId: string;
  }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const { threadId } = await params;
  // Anonymous share-link visitors may ask AI too (they can already trigger AI
  // edits); access is resolved from the share token below.
  const user = await getCurrentUser();

  const body = await request.json().catch(() => null);
  const parsed = askAiSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid AI request payload." }, { status: 400 });
  }

  const thread = await db.commentThread.findUnique({
    where: { id: threadId },
    select: {
      id: true,
      anchorText: true,
      anchorContext: true,
      documentId: true,
      document: {
        select: {
          id: true,
          title: true,
          content: true,
          repoUrl: true,
          agentModel: true,
          agentEffort: true,
          runnerMode: true
        }
      },
      comments: {
        orderBy: {
          createdAt: "asc"
        },
        select: {
          body: true,
          author: {
            select: {
              name: true
            }
          },
          aiModel: true
        }
      }
    }
  });

  if (!thread) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  const access = await resolveDocumentAccess(
    thread.documentId,
    user?.id,
    parsed.data.shareToken ?? null
  );
  if (!access || !canComment(access.permission)) {
    if (!user && !parsed.data.shareToken) {
      return NextResponse.json({ error: "You must be signed in to ask AI." }, { status: 401 });
    }
    return NextResponse.json({ error: "You do not have comment access." }, { status: 403 });
  }

  // Agent runs are expensive; cap how many a single user can kick off per minute
  // to prevent cost-amplification / DoS. Anonymous visitors are keyed by IP,
  // matching the ai-edit route.
  const runLimitKey = user ? `ai-run:user:${user.id}` : `ai-run:ip:${getClientIp(request)}`;
  const runLimit = rateLimit(runLimitKey, 10, 60_000);
  if (!runLimit.allowed) {
    return NextResponse.json(
      { error: "You're starting AI runs too quickly. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(runLimit.retryAfterSeconds) } }
    );
  }

  const aiRun = await db.aiRun.create({
    data: {
      documentId: thread.documentId,
      triggerType: "COMMENT_THREAD",
      createdById: user?.id ?? null,
      triggerId: thread.id,
      instruction: "Write the next assistant reply for this comment thread.",
      progress: "Starting Claude research agent.",
      // Comment-reply runs never commit content; any document edits they make are
      // tracked-change suggestions, so a comment-access user may mark them applied.
      suggestOnly: true
    }
  });
  await recordAiRunEvent({
    aiRunId: aiRun.id,
    role: "user",
    message: "Write the next assistant reply for this comment thread."
  });

  // Kick the agent off in the background and return immediately. The client
  // tracks the run via polling and gets the posted comment over SSE.
  void runAskAiInBackground({
    aiRunId: aiRun.id,
    thread,
    createdById: user?.id ?? null,
    agentAccessMode: agentAccessModeForDocumentAccess(access)
  }).catch((error) => {
    console.error("[ask-ai] background run threw", {
      threadId: thread.id,
      aiRunId: aiRun.id,
      error: error instanceof Error ? error.message : error
    });
  });

  return NextResponse.json({ aiRunId: aiRun.id, status: aiRun.status }, { status: 202 });
}
