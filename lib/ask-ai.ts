// Shared background runner for comment-thread "ask AI" replies. Extracted
// from app/api/comments/[threadId]/ask-ai/route.ts (mirroring
// lib/agent-conversation.ts's extraction) so it is not a route-file export —
// Next.js's route type-checking rejects extra named exports from route.ts —
// and so tests can exercise the selfHosted-vs-managed worktree/runner branch
// directly.

import { markAiRunSucceeded, recordAiRunEvent, startAiRunHeartbeat } from "@/lib/ai-runs";
import {
  RUN_CANCELLED_MESSAGE,
  deregisterRunAbortController,
  isRunCancellation,
  registerRunAbortController
} from "@/lib/agent-runner/run-registry";
import { broadcastDocumentEvent } from "@/lib/collaboration";
import { serializeComment } from "@/lib/document-data";
import { getAgentRunner, getSelfHostedRunner } from "@/lib/agent-runner";
import {
  getContextAroundMatch,
  getDocumentAiBlocks,
  getDocumentPlainText,
  parseDocumentContent
} from "@/lib/content";
import { db } from "@/lib/db";
import { resolveAgentConfigForUser } from "@/lib/agent-defaults";
import { loadAgentEnvWithFreeFallback, restrictAgentEnvForReadOnly } from "@/lib/user-credentials";
import type { AgentAccessMode } from "@/agent-core";
import { normalizeAgentImages } from "@/lib/ai-edit-submission";
import { createLiveCommentRecorder } from "@/lib/agent-comments";
import { flattenDocumentTextNodes } from "@/lib/suggestion-content";
import { normalizeSourceLinks, serializeSourceLinks } from "@/lib/sources";
import {
  commitWorkspaceChanges,
  ensureLinkedRepositoryWorktree,
  getWorkspaceOverview,
  removeRunWorktree
} from "@/lib/research-workspace";

export type ThreadForReply = {
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
    runnerMode: string;
  };
  comments: Array<{ body: string; author: { name: string } | null; aiModel: string | null }>;
};

// Runs the comment-reply agent off the request path. The HTTP handler returns
// 202 immediately; the client tracks completion via AiRun polling and receives
// the posted comment over the SSE `comment-created` broadcast. This avoids the
// Cloudflare ~100s origin timeout (524) that killed long synchronous replies.
export async function runAskAiInBackground(input: {
  aiRunId: string;
  thread: ThreadForReply;
  createdById: string | null;
  agentAccessMode: AgentAccessMode;
}) {
  const { aiRunId, thread, createdById, agentAccessMode } = input;
  // selfHosted documents: never manage a worktree ourselves — the owner's
  // external worker clones and works in its own checkout. Mirrors the
  // isSelfHosted gating in app/api/documents/[id]/ai-edit/route.ts.
  const isSelfHosted = thread.document.runnerMode === "selfHosted";
  const runner = isSelfHosted ? getSelfHostedRunner() : getAgentRunner();
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
    linkedRepo = isSelfHosted
      ? null
      : await ensureLinkedRepositoryWorktree(thread.documentId, aiRunId, createdById);
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
    const {
      agentEnv,
      agentConfig: effectiveAgentConfig,
      usedFreeFallback
    } = await loadAgentEnvWithFreeFallback(
      thread.documentId,
      // Doc agent-panel config -> triggering user's default -> app default.
      await resolveAgentConfigForUser(thread.document, createdById),
      createdById,
      { aiRunId }
    );
    if (usedFreeFallback) {
      await recordAiRunEvent({
        aiRunId,
        role: "system",
        message: `No AI credential connected — running on the free local model (${effectiveAgentConfig.model}). It is much slower than Claude (first output can take a few minutes). Connect a credential under AI settings in the topbar to use Claude.`
      });
    }
    if (agentAccessMode === "read_only") {
      await recordAiRunEvent({
        aiRunId,
        role: "system",
        message: "Share-link agent is read-only: repository writes, commands, document secrets, commits, and pushes are disabled."
      });
    }

    // Comments the agent leaves via add_comment are created (and broadcast)
    // the moment they arrive, so collaborators see review feedback mid-run.
    const commentRecorder = createLiveCommentRecorder({
      documentId: thread.documentId,
      aiRunId,
      createdById,
      model: effectiveAgentConfig.model ?? null,
      documentText
    });

    const aiReply = await runner.run({
      mode: "comment_reply",
      accessMode: agentAccessMode,
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
      agentConfig: effectiveAgentConfig,
      agentEnv: agentAccessMode === "read_only" ? restrictAgentEnvForReadOnly(agentEnv) : agentEnv,
      signal: abort.signal,
      containerName: `gdocs-run-${aiRunId}`,
      documentId: thread.documentId,
      aiRunId,
      validation: { kind: "comment_reply", documentText: suggestionAnchorText },
      onComment: commentRecorder.onComment,
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
    const commit = linkedRepo && agentAccessMode === "workspace"
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

    // Create threads for any review comments that arrived only in
    // submit_response's comments array (live add_comment ones already exist);
    // the client adds the commentAnchor marks when it processes this run.
    const agentComments = await commentRecorder.finalize(
      Array.isArray(aiReply.comments) ? aiReply.comments : [],
      aiReply.model
    );

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
    if (linkedRepo && agentAccessMode === "workspace") {
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
