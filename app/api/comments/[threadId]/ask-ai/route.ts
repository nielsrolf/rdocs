import { NextResponse } from "next/server";
import { z } from "zod";

import { recordAiRunEvent } from "@/lib/ai-runs";
import { getCurrentUser } from "@/lib/auth";
import { broadcastDocumentEvent } from "@/lib/collaboration";
import { serializeComment } from "@/lib/document-data";
import { getAgentRunner } from "@/lib/agent-runner";
import {
  getContextAroundMatch,
  getDocumentAiBlocks,
  getDocumentPlainText,
  parseDocumentContent
} from "@/lib/content";
import { db } from "@/lib/db";
import { loadDocumentEnv } from "@/lib/document-env";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeSourceLinks, serializeSourceLinks } from "@/lib/sources";
import {
  commitWorkspaceChanges,
  ensureLinkedRepositoryWorktree,
  getWorkspaceOverview,
  removeRunWorktree
} from "@/lib/research-workspace";

export const runtime = "nodejs";

const askAiSchema = z.object({
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    threadId: string;
  }>;
};

type ThreadForReply = {
  id: string;
  anchorText: string;
  anchorContext: string | null;
  documentId: string;
  document: {
    id: string;
    title: string;
    content: string;
    repoUrl: string | null;
    agentModel: string | null;
    agentEffort: string | null;
  };
  comments: Array<{ body: string; author: { name: string } | null; aiModel: string | null }>;
};

// Runs the comment-reply agent off the request path. The HTTP handler returns
// 202 immediately; the client tracks completion via AiRun polling and receives
// the posted comment over the SSE `comment-created` broadcast. This avoids the
// Cloudflare ~100s origin timeout (524) that killed long synchronous replies.
async function runAskAiInBackground(input: { aiRunId: string; thread: ThreadForReply }) {
  const { aiRunId, thread } = input;
  let linkedRepo: Awaited<ReturnType<typeof ensureLinkedRepositoryWorktree>> = null;

  try {
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
    linkedRepo = await ensureLinkedRepositoryWorktree(thread.documentId, aiRunId);
    if (linkedRepo) {
      await db.aiRun.update({
        where: { id: aiRunId },
        data: {
          workspacePath: linkedRepo.workspace,
          branchName: linkedRepo.branchName
        }
      });
      await recordAiRunEvent({
        aiRunId,
        role: "system",
        message: `Using isolated worktree ${linkedRepo.workspace} on branch ${linkedRepo.branchName}.`
      });
    }
    const workspaceOverview = await getWorkspaceOverview(linkedRepo?.workspace ?? null);
    const agentEnv = await loadDocumentEnv(thread.documentId);

    const aiReply = await getAgentRunner().run({
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
    }, {
      agentConfig: { model: thread.document.agentModel, effort: thread.document.agentEffort },
      agentEnv,
      onProgress: async (event) => {
        await Promise.all([
          db.aiRun.update({
            where: { id: aiRunId },
            data: { progress: event.message }
          }),
          recordAiRunEvent({
            aiRunId,
            role: event.role ?? "agent",
            message: event.message
          })
        ]).catch(() => null);
      }
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
    const sourceLinks = normalizeSourceLinks([
      ...(Array.isArray(aiReply.sources) ? aiReply.sources : []),
      ...(Array.isArray(aiReply.sourceLinks) ? aiReply.sourceLinks : [])
    ]);

    const comment = await db.comment.create({
      data: {
        threadId: thread.id,
        body: aiReply.reply ?? aiReply.summary ?? "The research agent finished without a reply.",
        aiModel: aiReply.model,
        sourceLinks: serializeSourceLinks(sourceLinks),
        commitSha: commit.commitSha,
        commitUrl: commit.commitUrl,
        aiRunId
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
      where: { id: aiRunId },
      data: {
        status: "SUCCEEDED",
        model: aiReply.model,
        commitSha: commit.commitSha,
        commitUrl: commit.commitUrl,
        finishedAt: new Date()
      }
    });
    await recordAiRunEvent({
      aiRunId,
      role: "agent",
      message: aiReply.summary || "Finished AI comment reply."
    });

    const serialized = serializeComment(comment);
    // Broadcast to all connected clients (including the originator, who relies
    // on this since the HTTP response returned before the comment existed).
    broadcastDocumentEvent(thread.documentId, "comment-created", {
      threadId: thread.id,
      comment: serialized
    });
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

    await recordAiRunEvent({
      aiRunId,
      role: "error",
      message: error instanceof Error ? error.message : "AI run failed."
    }).catch(() => null);
    await db.aiRun
      .update({
        where: { id: aiRunId },
        data: {
          status: "FAILED",
          error: error instanceof Error ? error.message : "AI run failed.",
          finishedAt: new Date()
        }
      })
      .catch(() => null);
  } finally {
    if (linkedRepo && linkedRepo.baseWorkspace !== linkedRepo.worktree) {
      await removeRunWorktree(linkedRepo).catch(() => null);
    }
  }
}

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
          repoUrl: true,
          agentModel: true,
          agentEffort: true
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

  // Agent runs are expensive; cap how many a single user can kick off per minute
  // to prevent cost-amplification / DoS.
  const runLimit = rateLimit(`ai-run:user:${user.id}`, 10, 60_000);
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
      triggerId: thread.id,
      instruction: "Write the next assistant reply for this comment thread.",
      progress: "Starting Claude research agent."
    }
  });
  await recordAiRunEvent({
    aiRunId: aiRun.id,
    role: "user",
    message: "Write the next assistant reply for this comment thread."
  });

  // Kick the agent off in the background and return immediately. The client
  // tracks the run via polling and gets the posted comment over SSE.
  void runAskAiInBackground({ aiRunId: aiRun.id, thread }).catch((error) => {
    console.error("[ask-ai] background run threw", {
      threadId: thread.id,
      aiRunId: aiRun.id,
      error: error instanceof Error ? error.message : error
    });
  });

  return NextResponse.json({ aiRunId: aiRun.id, status: aiRun.status }, { status: 202 });
}
