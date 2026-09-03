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
  recordAiRunEvent
} from "@/lib/ai-runs";
import { withAgentRunLifecycle } from "@/lib/agent-run-lifecycle";
import { loadDocumentMcpServerInputs } from "@/lib/document-mcp-servers";
import { planSessionResume, recordRunSessionId, withConversationLock } from "@/lib/agent-sessions";
import { getDocumentAiBlocks, getDocumentPlainText, parseDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import type { AgentAccessMode, ClaudeResearchAgentInput } from "@/agent-core";
import type { AgentComment } from "@/agent-core/ai-edit-submission";
import { normalizeAgentImages } from "@/lib/ai-edit-submission";
import { createLiveCommentRecorder } from "@/lib/agent-comments";
import { flattenDocumentAnchorText } from "@/lib/suggestion-content";
import { getWorkspaceOverview } from "@/lib/research-workspace";
import { getLinkedWorkspaceDocContext } from "@/lib/workspace-link";
import { persistRefreshedCodexAuth } from "@/lib/user-credentials";

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
  agentConfig: { model: string | null; effort: string | null; userInstructions?: string | null };
  agentAccessMode: AgentAccessMode;
  // Document.runnerMode ("managed" | "selfHosted"). selfHosted documents never
  // get a worktree managed by this app — see the lifecycle wrapper's
  // selfHosted gating, mirroring the other agent entry points.
  runnerMode: string;
  documentEditMode?: "suggest" | "edit";
  // Host dev mode: run unsandboxed in this host directory (allowlisted Slack
  // dev channel only — see lib/slack/dev-mode.ts).
  hostDevDir?: string | null;
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

// The agent output fields a conversation run's terminal bookkeeping consumes.
// Loosely typed on purpose: the same tail now runs for a live in-process result
// (ClaudeResearchAgentOutput) AND for a result recovered from a detached session
// container across a restart, which arrives as a plain JSON object.
export type ConversationFinalizeResult = {
  reply?: string | null;
  summary?: string | null;
  model?: string | null;
  comments?: unknown;
  suggestions?: unknown;
  images?: unknown;
};

export type ConversationCommentFinalizer = {
  finalize: (
    submitted: AgentComment[] | undefined,
    model?: string | null
  ) => Promise<Array<{ threadId: string; findText: string }>>;
};

/**
 * Terminal bookkeeping of a SUCCEEDED conversation run: the reply event, the
 * agent's comment threads, and the AiRun row. Extracted from the live path so
 * boot adoption of a detached container (lib/agent-runner/session-adoption.ts)
 * finalizes a run in exactly the same shape — same event strings, same order,
 * same fields — instead of a second, drifting implementation.
 */
export async function finalizeConversationRun(input: {
  aiRunId: string;
  documentId: string;
  result: ConversationFinalizeResult;
  commit: { commitSha: string | null; commitUrl: string | null };
  commentRecorder: ConversationCommentFinalizer;
}): Promise<string> {
  const { aiRunId, documentId, result, commit, commentRecorder } = input;

  const reply = result.reply ?? result.summary ?? "Finished agent conversation.";
  await recordAiRunEvent({
    aiRunId,
    role: "agent",
    message: reply
  });

  const agentComments = await commentRecorder.finalize(
    Array.isArray(result.comments) ? (result.comments as AgentComment[]) : [],
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
  return reply;
}

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
    runnerMode,
    documentEditMode,
    hostDevDir,
    slackContext,
    slackTools,
    onSlackMessage,
    onFinished
  } = input;

  const lifecycleResult = await withAgentRunLifecycle(
    {
      aiRunId,
      documentId,
      createdById,
      agentAccessMode,
      runnerMode,
      // Host dev mode and selfHosted are mutually exclusive in practice (host
      // dev runs are an allowlisted internal debugging path); host dev wins if
      // both are somehow set, since it explicitly wants the deployment's own
      // checkout.
      hostDevDir,
      // The heartbeat starts once this run holds the session lock (below), not
      // when the background function starts: a run queued behind another run of
      // the same conversation is doing nothing, and must look silent so the
      // reaper can clear it rather than it posing as a live-but-unsteerable run.
      deferHeartbeat: true,
      failureCommitMessage: "Save failed AI conversation changes",
      defaultFailureMessage: "Agent conversation failed."
    },
    async (ctx) => {
      // Real session resume: when the follow-up chain has a recorded SDK session
      // whose transcript is still on disk, the run resumes it — the model sees
      // all its prior messages AND tool calls, uncapped. The plain-text
      // transcript replay (buildConversationHistory) remains the fallback for
      // pre-feature runs, GC'd sessions, and the self-hosted/http runners.
      const sessionsSupported = ctx.runner.mode === "container" || ctx.runner.mode === "inprocess";
      const sessionPlan = sessionsSupported
        ? await planSessionResume({
            documentId,
            aiRunId,
            previousRunId,
            runnerMode: ctx.runner.mode,
            agentModel: agentConfig.model
          }).catch(
            (error) => {
              console.warn("[agent-conversation] session resume planning failed; falling back to transcript replay", {
                aiRunId,
                error: error instanceof Error ? error.message : error
              });
              return null;
            }
          )
        : null;
      const resumeSessionId = sessionPlan?.resumeSessionId ?? null;
      const { history: conversationHistory } = resumeSessionId
        ? { history: [] as Array<{ role: string; message: string }> }
        : await buildConversationHistory(documentId, previousRunId);
      if (resumeSessionId) {
        await recordAiRunEvent({
          aiRunId,
          role: "system",
          message: "Resuming the previous agent session — the model sees its full prior context (messages and tool calls)."
        });
      } else if (sessionPlan?.resumeUnavailableSessionId) {
        // Never degrade silently: the model is about to lose every tool call of
        // the conversation and all but the last few chat messages. Say it in the
        // timeline so a confused-looking follow-up has a visible cause.
        console.warn("[agent-conversation] session transcript unavailable; degraded to transcript replay", {
          aiRunId,
          sessionId: sessionPlan.resumeUnavailableSessionId
        });
        await recordAiRunEvent({
          aiRunId,
          role: "system",
          message:
            "The previous session transcript is no longer available, so this run continues from a condensed chat transcript only — earlier tool calls and file reads are NOT in context."
        });
      }

      // Host dev runs operate directly on the deployment checkout — no worktree,
      // no end-of-run commit/cleanup. selfHosted runs never get a worktree from
      // this app either — the owner's external worker clones and works in its
      // own checkout. Both branches live in ctx.setupWorkspace.
      const linkedRepo = await ctx.setupWorkspace();

      const parsedContent = parseDocumentContent(documentContent);
      const documentText = getDocumentPlainText(parsedContent);
      // A Slack channel linked to a doc's workspace always reads that doc:
      // its content rides along in the run context. Anchoring surfaces
      // (comments, suggestions) stay on the channel doc's own text.
      const linkedWorkspaceDoc = await getLinkedWorkspaceDocContext(documentId);
      const runDocumentText = linkedWorkspaceDoc
        ? `${documentText}\n\n===== Linked project document: "${linkedWorkspaceDoc.title}" (this channel shares its workspace) =====\n${linkedWorkspaceDoc.text}`
        : documentText;
      const suggestionAnchorText = flattenDocumentAnchorText(parsedContent);
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
      const { agentEnv, runAgentEnv, effectiveAgentConfig } = await ctx.loadEnv(agentConfig);
      const mcpServers = await loadDocumentMcpServerInputs(documentId, agentEnv);
      // Comments the agent leaves via add_comment are created (and broadcast)
      // the moment they arrive, so collaborators see review feedback mid-run.
      const commentRecorder = createLiveCommentRecorder({
        documentId,
        aiRunId,
        createdById,
        model: effectiveAgentConfig.model ?? null,
        documentText
      });

      const result = await withConversationLock(
        sessionPlan?.conversationKey ?? aiRunId,
        () => {
          ctx.beginHeartbeat();
          return ctx.runner.run({
        mode: "conversation",
        documentEditMode: documentEditMode ?? "suggest",
        hostDevRun: Boolean(hostDevDir),
        githubAuthAvailable: Boolean(agentEnv.GITHUB_TOKEN?.trim() || agentEnv.GH_TOKEN?.trim()),
        accessMode: agentAccessMode,
        documentTitle,
        documentText: runDocumentText,
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
        workspacePath: hostDevDir ?? linkedRepo?.workspace ?? null,
        workspaceOverview,
        instruction: message,
        userInstructions: agentConfig.userInstructions ?? null,
        conversationHistory,
        resumeSessionId,
        slackContext,
        slackTools,
        mcpServers
      }, {
        agentConfig: effectiveAgentConfig,
        agentEnv: runAgentEnv,
        signal: ctx.abortSignal,
        containerName: `gdocs-run-${aiRunId}`,
        documentId,
        aiRunId,
        validation: { kind: "conversation", documentText: suggestionAnchorText },
        onComment: commentRecorder.onComment,
        onSlackMessage,
        // Persist the run's SDK session id (recorded at init, so failed and
        // cancelled runs stay resumable) and, for the container runner, mount
        // the conversation's session dir as CLAUDE_CONFIG_DIR.
        onSessionId: sessionsSupported ? (sessionId) => recordRunSessionId(aiRunId, sessionId) : undefined,
        // ChatGPT-subscription Codex runs rotate the auth.json refresh token;
        // persist the rotated blob back into the supplying credential row or a
        // later run fails with an expired token. Secret material — never logged.
        onCodexAuthRefreshed: (authJson) =>
          persistRefreshedCodexAuth(documentId, createdById, authJson).then(() => undefined),
        sessionDirHostPath: sessionPlan?.sessionDir,
        trustedHostRun: Boolean(hostDevDir),
        onProgress: ctx.onProgress
      });
        }
      );

      const commit = await ctx.commitRunChanges("AI research conversation changes");

      return await finalizeConversationRun({
        aiRunId,
        documentId,
        result,
        commit,
        commentRecorder
      });
    }
  );

  if (lifecycleResult.status === "HANDED_OFF") {
    // Another server process attached to this run's detached container and is now
    // its reader. The run is neither done nor failed here, so there is nothing to
    // report: firing onFinished would post a bogus Slack failure (and clear the
    // 👀) for a run that is still working. The adopting process finalizes it and
    // delivers the reply (lib/agent-runner/session-adoption.ts).
    console.log(`[agent-session] run ${aiRunId} handed off to another server process; not finalizing here.`);
    return;
  }

  const outcome: ConversationRunOutcome =
    lifecycleResult.status === "SUCCEEDED"
      ? { status: "SUCCEEDED", reply: lifecycleResult.value, error: null }
      : { status: "FAILED", reply: null, error: lifecycleResult.error };

  if (onFinished) {
    await Promise.resolve(onFinished(outcome)).catch((error) => {
      console.error("[agent-conversation] onFinished hook failed", {
        aiRunId,
        error: error instanceof Error ? error.message : error
      });
    });
  }
}
