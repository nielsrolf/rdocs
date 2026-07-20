// Shared background runner for document-level conversation agent runs.
//
// Extracted from app/api/documents/[id]/agents/route.ts so non-HTTP triggers
// (the Slack bot) can start the exact same run: same worktree lifecycle,
// credential resolution, live comments, heartbeat, and terminal bookkeeping.
// The HTTP route and the Slack event handler both create the AiRun row first
// and then hand off to runAgentConversationInBackground.

import {
  buildConversationHistory,
  markAiRunSucceeded,
  recordAiRunEvent,
  startAiRunHeartbeat
} from "@/lib/ai-runs";
import {
  RUN_CANCELLED_MESSAGE,
  deregisterRunAbortController,
  isRunCancellation,
  registerRunAbortController
} from "@/lib/agent-runner/run-registry";
import { getAgentRunner } from "@/lib/agent-runner";
import { getDocumentAiBlocks, getDocumentPlainText, parseDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import { loadAgentEnvWithFreeFallback, restrictAgentEnvForReadOnly } from "@/lib/user-credentials";
import type { AgentAccessMode, ClaudeResearchAgentInput } from "@/agent-core";
import { normalizeAgentImages } from "@/lib/ai-edit-submission";
import { createLiveCommentRecorder } from "@/lib/agent-comments";
import { flattenDocumentTextNodes } from "@/lib/suggestion-content";
import {
  commitWorkspaceChanges,
  ensureLinkedRepositoryWorktree,
  getWorkspaceOverview,
  removeRunWorktree
} from "@/lib/research-workspace";

export type ConversationRunOutcome = {
  status: "SUCCEEDED" | "FAILED";
  // The agent's conversational reply (falls back to the run summary).
  reply: string | null;
  error: string | null;
};

export type ConversationRunInput = {
  documentId: string;
  aiRunId: string;
  message: string;
  previousRunId: string | null;
  documentTitle: string;
  documentContent: string;
  createdById: string | null;
  agentConfig: { model: string | null; effort: string | null };
  agentAccessMode: AgentAccessMode;
  // Set for Slack-triggered runs: prompt context + the post_slack_message tool.
  slackContext?: ClaudeResearchAgentInput["slackContext"];
  // Run-scoped HTTP callback enabling the Slack read tools.
  slackTools?: ClaudeResearchAgentInput["slackTools"];
  // Live delivery of interim Slack updates the agent posts mid-run.
  onSlackMessage?: (text: string) => Promise<void> | void;
  // Called once after the run reaches a terminal state (bookkeeping already
  // persisted). Used by the Slack bot to deliver the reply to the thread.
  onFinished?: (outcome: ConversationRunOutcome) => Promise<void> | void;
};

export async function runAgentConversationInBackground(input: ConversationRunInput) {
  const {
    documentId,
    aiRunId,
    message,
    previousRunId,
    documentTitle,
    documentContent,
    createdById,
    agentConfig,
    agentAccessMode,
    slackContext,
    slackTools,
    onSlackMessage,
    onFinished
  } = input;
  let linkedRepo: Awaited<ReturnType<typeof ensureLinkedRepositoryWorktree>> = null;
  const stopHeartbeat = startAiRunHeartbeat(aiRunId);
  const abort = registerRunAbortController(aiRunId);
  let outcome: ConversationRunOutcome | null = null;

  try {
    const { history: conversationHistory } = await buildConversationHistory(documentId, previousRunId);

    linkedRepo = await ensureLinkedRepositoryWorktree(documentId, aiRunId, createdById);
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

    const parsedContent = parseDocumentContent(documentContent);
    const documentText = getDocumentPlainText(parsedContent);
    const suggestionAnchorText = flattenDocumentTextNodes(parsedContent);
    const documentBlocks = getDocumentAiBlocks(parsedContent);
    const unresolvedThreads = await db.commentThread.findMany({
      where: {
        documentId,
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
    const workspaceOverview = await getWorkspaceOverview(linkedRepo?.workspace ?? null, documentId);
    const {
      agentEnv,
      agentConfig: effectiveAgentConfig,
      usedFreeFallback
    } = await loadAgentEnvWithFreeFallback(documentId, agentConfig, createdById);
    if (usedFreeFallback) {
      await recordAiRunEvent({
        aiRunId,
        role: "system",
        message: `No AI credential connected — running on the free local model (${effectiveAgentConfig.model}). It is much slower than Claude (first output can take a few minutes). Connect a credential under AI credentials in the topbar to use Claude.`
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
      documentId,
      aiRunId,
      createdById,
      model: effectiveAgentConfig.model ?? null,
      documentText
    });

    const result = await getAgentRunner().run({
      mode: "conversation",
      githubAuthAvailable: Boolean(agentEnv.GITHUB_TOKEN?.trim() || agentEnv.GH_TOKEN?.trim()),
      accessMode: agentAccessMode,
      documentTitle,
      documentText,
      documentBlocks,
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
      instruction: message,
      conversationHistory,
      slackContext,
      slackTools
    }, {
      agentConfig: effectiveAgentConfig,
      agentEnv: agentAccessMode === "read_only" ? restrictAgentEnvForReadOnly(agentEnv) : agentEnv,
      signal: abort.signal,
      containerName: `gdocs-run-${aiRunId}`,
      validation: { kind: "conversation", documentText: suggestionAnchorText },
      onComment: commentRecorder.onComment,
      onSlackMessage,
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
          message: "AI research conversation changes",
          push: true
        })
      : { commitSha: null, commitUrl: null, pushed: false, pushError: null as string | null };
    if (commit.pushError) {
      await recordAiRunEvent({
        aiRunId,
        role: "error",
        message: `Changes were committed locally but could not be pushed to the linked repository: ${commit.pushError}`
      }).catch(() => null);
    }

    const reply = result.reply ?? result.summary ?? "Finished agent conversation.";
    await recordAiRunEvent({
      aiRunId,
      role: "agent",
      message: reply
    });

    const agentComments = await commentRecorder.finalize(
      Array.isArray(result.comments) ? result.comments : [],
      result.model
    );

    await markAiRunSucceeded(aiRunId, {
      progress: result.summary ?? "Finished.",
      model: result.model,
      commitSha: commit.commitSha,
      commitUrl: commit.commitUrl,
      suggestions: JSON.stringify(Array.isArray(result.suggestions) ? result.suggestions : []),
      agentComments: JSON.stringify(agentComments),
      replacementImages: JSON.stringify(normalizeAgentImages(result.images, documentId, null, aiRunId))
    });
    outcome = { status: "SUCCEEDED", reply, error: null };
  } catch (error) {
    if (linkedRepo && agentAccessMode === "workspace") {
      await commitWorkspaceChanges({
        workspace: linkedRepo.workspace,
        baseWorkspace: linkedRepo.baseWorkspace,
        repoUrl: linkedRepo.url,
        message: "Save failed AI conversation changes",
        push: true
      }).catch(() => null);
    }

    const failureMessage = isRunCancellation(error, abort.signal)
      ? RUN_CANCELLED_MESSAGE
      : error instanceof Error
        ? error.message
        : "Agent conversation failed.";
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
    outcome = { status: "FAILED", reply: null, error: failureMessage };
  } finally {
    deregisterRunAbortController(aiRunId);
    stopHeartbeat();
    if (linkedRepo && linkedRepo.baseWorkspace !== linkedRepo.worktree) {
      await removeRunWorktree(linkedRepo).catch(() => null);
    }
  }

  if (outcome && onFinished) {
    await Promise.resolve(onFinished(outcome)).catch((error) => {
      console.error("[agent-conversation] onFinished hook failed", {
        aiRunId,
        error: error instanceof Error ? error.message : error
      });
    });
  }
}
