// Shared background runner for comment-thread "ask AI" replies. Extracted
// from app/api/comments/[threadId]/ask-ai/route.ts (mirroring
// lib/agent-conversation.ts's extraction) so it is not a route-file export —
// Next.js's route type-checking rejects extra named exports from route.ts —
// and so tests can exercise the selfHosted-vs-managed worktree/runner branch
// directly.

import { RUN_STARTED_CLAUDE } from "@/agent-core/lifecycle-messages";
import { markAiRunSucceeded, recordAiRunEvent } from "@/lib/ai-runs";
import { withAgentRunLifecycle } from "@/lib/agent-run-lifecycle";
import { broadcastDocumentEvent } from "@/lib/collaboration";
import { serializeComment } from "@/lib/document-data";
import {
  getContextAroundMatch,
  getDocumentAiBlocks,
  getDocumentPlainText,
  parseDocumentContent
} from "@/lib/content";
import { db } from "@/lib/db";
import { resolveAgentConfigForUser } from "@/lib/agent-defaults";
import type { AgentAccessMode } from "@/agent-core";
import { normalizeAgentImages } from "@/lib/ai-edit-submission";
import { createLiveCommentRecorder } from "@/lib/agent-comments";
import { notifyCommentPosted } from "@/lib/comment-notifications";
import { flattenDocumentTextNodes } from "@/lib/suggestion-content";
import { normalizeSourceLinks, serializeSourceLinks } from "@/lib/sources";
import { getWorkspaceOverview } from "@/lib/research-workspace";
import { persistRefreshedCodexAuth } from "@/lib/user-credentials";

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

// Kick off a comment-thread Ask-AI run outside the HTTP route — used when a
// Slack DM reply to a comment notification mentions the bot (lib/slack/events.ts).
// Mirrors app/api/comments/[threadId]/ask-ai/route.ts: creates the AiRun row
// and fires runAskAiInBackground; the AI's reply lands as a comment and flows
// back out through the normal comment-created broadcast + notifications.
// Caller must have verified comment access already.
export async function startAskAiRunForThread(input: {
  threadId: string;
  userId: string;
  agentAccessMode: AgentAccessMode;
}): Promise<string | null> {
  const thread = await db.commentThread.findUnique({
    where: { id: input.threadId },
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
        orderBy: { createdAt: "asc" },
        select: { body: true, author: { select: { name: true } }, aiModel: true }
      }
    }
  });
  if (!thread) return null;
  const aiRun = await db.aiRun.create({
    data: {
      documentId: thread.documentId,
      triggerType: "COMMENT_THREAD",
      createdById: input.userId,
      triggerId: thread.id,
      instruction: "Write the next assistant reply for this comment thread.",
      progress: RUN_STARTED_CLAUDE,
      suggestOnly: true
    }
  });
  await recordAiRunEvent({
    aiRunId: aiRun.id,
    role: "user",
    message: "Write the next assistant reply for this comment thread."
  });
  void runAskAiInBackground({
    aiRunId: aiRun.id,
    thread,
    createdById: input.userId,
    agentAccessMode: input.agentAccessMode
  }).catch((error) => {
    console.error("[ask-ai] background run threw", {
      threadId: thread.id,
      aiRunId: aiRun.id,
      error: error instanceof Error ? error.message : error
    });
  });
  return aiRun.id;
}

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

  await withAgentRunLifecycle(
    {
      aiRunId,
      documentId: thread.documentId,
      createdById,
      agentAccessMode,
      // selfHosted documents: never manage a worktree ourselves — the owner's
      // external worker clones and works in its own checkout (gated inside the
      // lifecycle wrapper, mirroring the other agent entry points).
      runnerMode: thread.document.runnerMode,
      failureCommitMessage: `Save failed AI comment changes for ${thread.id}`,
      onFailureCommitError: (commitError) => {
        console.error("Failed to commit AI comment workspace changes", {
          threadId: thread.id,
          error: commitError instanceof Error ? commitError.message : commitError
        });
      },
      onRunError: (error) => {
        console.error("ask-ai failed", {
          threadId: thread.id,
          error: error instanceof Error ? error.message : error
        });
      },
      defaultFailureMessage: "AI run failed."
    },
    async (ctx) => {
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
      const linkedRepo = await ctx.setupWorkspace();
      const workspaceOverview = await getWorkspaceOverview(linkedRepo?.workspace ?? null, thread.documentId);
      // Doc agent-panel config -> triggering user's default -> app default.
      const resolvedConfig = await resolveAgentConfigForUser(thread.document, createdById);
      const { runAgentEnv, effectiveAgentConfig } = await ctx.loadEnv(resolvedConfig);

      // Comments the agent leaves via add_comment are created (and broadcast)
      // the moment they arrive, so collaborators see review feedback mid-run.
      const commentRecorder = createLiveCommentRecorder({
        documentId: thread.documentId,
        aiRunId,
        createdById,
        model: effectiveAgentConfig.model ?? null,
        documentText
      });

      const aiReply = await ctx.runner.run({
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
        userInstructions: resolvedConfig.userInstructions,
        anchorText: thread.anchorText,
        anchorContext: derivedAnchorContext,
        comments: thread.comments.map((comment) => ({
          author: comment.author?.name ?? comment.aiModel ?? "Claude",
          body: comment.body
        }))
      }, {
        agentConfig: effectiveAgentConfig,
        agentEnv: runAgentEnv,
        signal: ctx.abortSignal,
        containerName: `gdocs-run-${aiRunId}`,
        documentId: thread.documentId,
        aiRunId,
        validation: { kind: "comment_reply", documentText: suggestionAnchorText },
        onComment: commentRecorder.onComment,
        onProgress: ctx.onProgress,
        // ChatGPT-subscription Codex runs rotate the auth.json refresh token;
        // persist it back into the supplying credential row. Secret material.
        onCodexAuthRefreshed: (authJson) =>
          persistRefreshedCodexAuth(thread.documentId, createdById, authJson).then(() => undefined)
      });
      const commit = await ctx.commitRunChanges(`AI research for document comment ${thread.id}`);
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
        // The timeline should show what was actually posted, not merely the
        // structured response's terse bookkeeping summary.
        message: aiReply.reply ?? aiReply.summary ?? "The research agent finished without a reply."
      });

      const serialized = serializeComment(comment);
      // Broadcast to all connected clients (including the originator, who relies
      // on this since the HTTP response returned before the comment existed).
      broadcastDocumentEvent(thread.documentId, "comment-created", {
        threadId: thread.id,
        comment: serialized
      });
      // Slack DMs for everyone watching the doc — including the user who asked:
      // when the ask came from a DM reply (@claudex in a notification thread),
      // this is exactly how the answer gets back into their Slack thread.
      void notifyCommentPosted({
        threadId: thread.id,
        documentId: thread.documentId,
        commentBody: comment.body,
        authorLabel: aiReply.model ?? "Claude"
      });
    }
  );
}
