import { NextResponse } from "next/server";
import { z } from "zod";

import { recordAiRunEvent, serializeAiRun } from "@/lib/ai-runs";
import { runClaudeResearchAgent } from "@/lib/ai";
import { getCurrentUser } from "@/lib/auth";
import { getDocumentPlainText, parseDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";
import { commitWorkspaceChanges, ensureLinkedRepositoryWorktree, getWorkspaceOverview } from "@/lib/research-workspace";

export const runtime = "nodejs";

const agentConversationSchema = z.object({
  message: z.string().min(1).max(6000),
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "You must be signed in to message an agent." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = agentConversationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid agent message payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user.id, parsed.data.shareToken ?? null);
  if (!access || !canComment(access.permission)) {
    return NextResponse.json({ error: "You do not have agent access." }, { status: 403 });
  }

  let aiRunId: string | null = null;
  let linkedRepo: Awaited<ReturnType<typeof ensureLinkedRepositoryWorktree>> = null;

  try {
    const aiRun = await db.aiRun.create({
      data: {
        documentId: id,
        triggerType: "CONVERSATION",
        instruction: parsed.data.message.trim(),
        progress: "Starting Claude research agent."
      }
    });
    aiRunId = aiRun.id;
    await recordAiRunEvent({
      aiRunId: aiRun.id,
      role: "user",
      message: parsed.data.message.trim()
    });

    linkedRepo = await ensureLinkedRepositoryWorktree(id, aiRun.id);
    if (linkedRepo) {
      await db.aiRun.update({
        where: { id: aiRun.id },
        data: {
          workspacePath: linkedRepo.workspace,
          branchName: linkedRepo.branchName
        }
      });
      await recordAiRunEvent({
        aiRunId: aiRun.id,
        role: "system",
        message: `Using isolated worktree ${linkedRepo.workspace} on branch ${linkedRepo.branchName}.`
      });
    }

    const documentContent = parseDocumentContent(access.document.content);
    const documentText = getDocumentPlainText(documentContent);
    const unresolvedThreads = await db.commentThread.findMany({
      where: {
        documentId: id,
        status: "OPEN"
      },
      orderBy: {
        updatedAt: "desc"
      },
      select: {
        id: true,
        anchorText: true,
        anchorContext: true,
        comments: {
          orderBy: { createdAt: "asc" },
          select: {
            body: true,
            author: { select: { name: true } },
            aiModel: true
          }
        }
      }
    });
    const workspaceOverview = await getWorkspaceOverview(linkedRepo?.workspace ?? null);
    const result = await runClaudeResearchAgent({
      mode: "conversation",
      documentTitle: access.document.title,
      documentText,
      unresolvedThreads: unresolvedThreads.map((thread) => ({
        id: thread.id,
        anchorText: thread.anchorText,
        anchorContext: thread.anchorContext,
        comments: thread.comments.map((comment) => ({
          author: comment.author?.name ?? comment.aiModel ?? "Claude",
          body: comment.body
        }))
      })),
      workspacePath: linkedRepo?.workspace ?? null,
      workspaceOverview,
      instruction: parsed.data.message.trim()
    }, async (event) => {
      await Promise.all([
        db.aiRun.update({
          where: { id: aiRun.id },
          data: { progress: event.message }
        }),
        recordAiRunEvent({
          aiRunId: aiRun.id,
          role: event.role ?? "agent",
          message: event.message
        })
      ]).catch(() => null);
    });

    const commit = linkedRepo
      ? await commitWorkspaceChanges({
          workspace: linkedRepo.workspace,
          repoUrl: linkedRepo.url,
          message: "AI research conversation changes",
          push: true
        })
      : { commitSha: null, commitUrl: null, pushed: false };

    await recordAiRunEvent({
      aiRunId: aiRun.id,
      role: "agent",
      message: result.reply ?? result.summary ?? "Finished agent conversation."
    });
    const updated = await db.aiRun.update({
      where: { id: aiRun.id },
      data: {
        status: "SUCCEEDED",
        progress: result.summary ?? "Finished.",
        model: result.model,
        commitSha: commit.commitSha,
        commitUrl: commit.commitUrl,
        finishedAt: new Date()
      },
      include: {
        events: {
          orderBy: { createdAt: "asc" }
        }
      }
    });

    return NextResponse.json({ aiRun: serializeAiRun(updated) });
  } catch (error) {
    if (linkedRepo) {
      await commitWorkspaceChanges({
        workspace: linkedRepo.workspace,
        repoUrl: linkedRepo.url,
        message: "Save failed AI conversation changes",
        push: true
      }).catch(() => null);
    }

    if (aiRunId) {
      await recordAiRunEvent({
        aiRunId,
        role: "error",
        message: error instanceof Error ? error.message : "Agent conversation failed."
      }).catch(() => null);
      await db.aiRun.update({
        where: { id: aiRunId },
        data: {
          status: "FAILED",
          error: error instanceof Error ? error.message : "Agent conversation failed.",
          finishedAt: new Date()
        }
      }).catch(() => null);
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent conversation failed." },
      { status: 500 }
    );
  }
}
