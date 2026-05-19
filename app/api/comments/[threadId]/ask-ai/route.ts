import { NextResponse } from "next/server";
import { z } from "zod";

import { recordAiRunEvent } from "@/lib/ai-runs";
import { getCurrentUser } from "@/lib/auth";
import { serializeComment } from "@/lib/document-data";
import { runClaudeResearchAgent } from "@/lib/ai";
import {
  getContextAroundMatch,
  getDocumentAiBlocks,
  getDocumentPlainText,
  parseDocumentContent
} from "@/lib/content";
import { db } from "@/lib/db";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";
import { serializeSourceLinks } from "@/lib/sources";
import { commitWorkspaceChanges, ensureLinkedRepositoryWorktree, getWorkspaceOverview } from "@/lib/research-workspace";

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
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "You must be signed in to ask AI." }, { status: 401 });
  }

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
          repoUrl: true
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
    user.id,
    parsed.data.shareToken ?? null
  );
  if (!access || !canComment(access.permission)) {
    return NextResponse.json({ error: "You do not have comment access." }, { status: 403 });
  }

  let aiRunId: string | null = null;
  let linkedRepo: Awaited<ReturnType<typeof ensureLinkedRepositoryWorktree>> = null;

  try {
    const aiRun = await db.aiRun.create({
      data: {
        documentId: thread.documentId,
        triggerType: "COMMENT_THREAD",
        triggerId: thread.id,
        instruction: "Write the next assistant reply for this comment thread.",
        progress: "Starting Claude research agent."
      }
    });
    aiRunId = aiRun.id;
    await recordAiRunEvent({
      aiRunId: aiRun.id,
      role: "user",
      message: "Write the next assistant reply for this comment thread."
    });

    const documentContent = parseDocumentContent(thread.document.content);
    const documentText = getDocumentPlainText(documentContent);
    const documentBlocks = getDocumentAiBlocks(documentContent);
    const derivedAnchorContext =
      thread.anchorContext || getContextAroundMatch(documentText, thread.anchorText);
    const unresolvedThreads = await db.commentThread.findMany({
      where: {
        documentId: thread.documentId,
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
    linkedRepo = await ensureLinkedRepositoryWorktree(thread.documentId, aiRun.id);
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
    const workspaceOverview = await getWorkspaceOverview(linkedRepo?.workspace ?? null);

    const aiReply = await runClaudeResearchAgent({
      mode: "comment_reply",
      documentTitle: thread.document.title,
      documentText,
      documentBlocks,
      unresolvedThreads: unresolvedThreads.map((candidate) => ({
        id: candidate.id,
        anchorText: candidate.anchorText,
        anchorContext: candidate.anchorContext,
        comments: candidate.comments.map((comment) => ({
          author: comment.author?.name ?? comment.aiModel ?? "Claude",
          body: comment.body
        }))
      })),
      workspacePath: linkedRepo?.workspace ?? null,
      workspaceOverview,
      instruction: "Write the next assistant reply for this comment thread.",
      anchorText: thread.anchorText,
      anchorContext: derivedAnchorContext,
      comments: thread.comments.map((comment) => ({
        author: comment.author?.name ?? comment.aiModel ?? "Claude",
        body: comment.body
      }))
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
          baseWorkspace: linkedRepo.baseWorkspace,
          repoUrl: linkedRepo.url,
          message: `AI research for document comment ${thread.id}`,
          push: true
        })
      : { commitSha: null, commitUrl: null, pushed: false };

    const comment = await db.comment.create({
      data: {
        threadId: thread.id,
        body: aiReply.reply ?? aiReply.summary ?? "The research agent finished without a reply.",
        aiModel: aiReply.model,
        sourceLinks: serializeSourceLinks([]),
        commitSha: commit.commitSha,
        commitUrl: commit.commitUrl,
        aiRunId: aiRun.id
      },
      select: {
        id: true,
        body: true,
        aiModel: true,
        createdAt: true,
        sourceLinks: true,
        commitSha: true,
        commitUrl: true,
        aiRunId: true,
        author: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    await db.commentThread.update({
      where: { id: thread.id },
      data: {
        updatedAt: new Date()
      }
    });
    await db.aiRun.update({
      where: { id: aiRun.id },
      data: {
        status: "SUCCEEDED",
        model: aiReply.model,
        commitSha: commit.commitSha,
        commitUrl: commit.commitUrl,
        finishedAt: new Date()
      }
    });
    await recordAiRunEvent({
      aiRunId: aiRun.id,
      role: "agent",
      message: aiReply.summary || "Finished AI comment reply."
    });

    return NextResponse.json({ comment: serializeComment(comment) });
  } catch (error) {
    if (linkedRepo) {
      await commitWorkspaceChanges({
        workspace: linkedRepo.workspace,
        baseWorkspace: linkedRepo.baseWorkspace,
        repoUrl: linkedRepo.url,
        message: `Save failed AI comment changes for ${thread.id}`,
        push: true
      }).catch((commitError) => {
        console.error("Failed to commit AI comment workspace changes", {
          threadId: thread.id,
          error: commitError instanceof Error ? commitError.message : commitError
        });
      });
    }

    console.error("ask-ai failed", {
      threadId: thread.id,
      error: error instanceof Error ? error.message : error
    });

    if (aiRunId) {
      await recordAiRunEvent({
        aiRunId,
        role: "error",
        message: error instanceof Error ? error.message : "AI run failed."
      }).catch(() => null);
      await db.aiRun.update({
        where: { id: aiRunId },
        data: {
          status: "FAILED",
          error: error instanceof Error ? error.message : "AI run failed.",
          finishedAt: new Date()
        }
      }).catch(() => null);
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The AI helper failed before producing a reply."
      },
      { status: 500 }
    );
  }
}
