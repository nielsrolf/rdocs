import { NextResponse } from "next/server";
import { z } from "zod";

import { markAiRunSucceeded, recordAiRunEvent, startAiRunHeartbeat } from "@/lib/ai-runs";
import {
  RUN_CANCELLED_MESSAGE,
  deregisterRunAbortController,
  isRunCancellation,
  registerRunAbortController
} from "@/lib/agent-runner/run-registry";
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
import { loadAgentEnvForDocument } from "@/lib/user-credentials";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";
import { normalizeAgentImages } from "@/lib/ai-edit-submission";
import { createAgentCommentThreads } from "@/lib/agent-comments";
import { flattenDocumentTextNodes } from "@/lib/suggestion-content";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
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
async function runAskAiInBackground(input: { aiRunId: string; thread: ThreadForReply; createdById: string | null }) {
  const { aiRunId, thread, createdById } = input;
  let linkedRepo: Awaited<ReturnType<typeof ensureLinkedRepositoryWorktree>> = null;
  const stopHeartbeat = startAiRunHeartbeat(aiRunId);
  const abort = registerRunAbortController(aiRunId);

  try {
    const documentContent = parseDocumentContent(thread.document.content);
    const documentText = getDocumentPlainText(documentContent);
    const suggestionAnchorText = flattenDocumentTextNodes(documentContent);
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
    const workspaceOverview = await getWorkspaceOverview(linkedRepo?.workspace ?? null, thread.documentId);
    const agentEnv = await loadAgentEnvForDocument(thread.documentId, thread.document.agentModel);

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
      signal: abort.signal,
      containerName: `gdocs-run-${aiRunId}`,
      validation: { kind: "comment_reply", documentText: suggestionAnchorText },
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
    if (commit.pushError) {
      await recordAiRunEvent({
        aiRunId,
        role: "error",
        message: `Changes were committed locally but could not be pushed to the linked repository: ${commit.pushError}`
      }).catch(() => null);
    }
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

    // Create any standalone review comments the agent anchored on the document.
    // Threads are created here (correctly AI-authored); the client adds the
    // commentAnchor mark when it processes this run.
    const agentComments = await createAgentCommentThreads({
      documentId: thread.documentId,
      aiRunId,
      createdById,
      model: aiReply.model,
      comments: Array.isArray(aiReply.comments) ? aiReply.comments : [],
      documentText
    });

    await markAiRunSucceeded(aiRunId, {
      model: aiReply.model,
      commitSha: commit.commitSha,
      commitUrl: commit.commitUrl,
      suggestions: JSON.stringify(Array.isArray(aiReply.suggestions) ? aiReply.suggestions : []),
      agentComments: JSON.stringify(agentComments),
      // Persist any repo images the agent committed so suggestions that cite
      // them with markdown can resolve the image when applied client-side.
      replacementImages: JSON.stringify(
        normalizeAgentImages(aiReply.images, thread.documentId, null, aiRunId)
      )
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

    const failureMessage = isRunCancellation(error, abort.signal)
      ? RUN_CANCELLED_MESSAGE
      : error instanceof Error
        ? error.message
        : "AI run failed.";
    await recordAiRunEvent({
      aiRunId,
      role: "error",
      message: failureMessage
    }).catch(() => null);
    await db.aiRun
      .update({
        where: { id: aiRunId },
        data: {
          status: "FAILED",
          error: failureMessage,
          finishedAt: new Date()
        }
      })
      .catch(() => null);
  } finally {
    deregisterRunAbortController(aiRunId);
    stopHeartbeat();
    if (linkedRepo && linkedRepo.baseWorkspace !== linkedRepo.worktree) {
      await removeRunWorktree(linkedRepo).catch(() => null);
    }
  }
}

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
  void runAskAiInBackground({ aiRunId: aiRun.id, thread, createdById: user?.id ?? null }).catch((error) => {
    console.error("[ask-ai] background run threw", {
      threadId: thread.id,
      aiRunId: aiRun.id,
      error: error instanceof Error ? error.message : error
    });
  });

  return NextResponse.json({ aiRunId: aiRun.id, status: aiRun.status }, { status: 202 });
}
