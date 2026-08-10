// Boot adoption of orphaned detached session containers.
//
// A detached agent container (container-session.ts) is nobody's child: it keeps
// working across a deploy or a crash of the process that started it. What is
// lost in that moment is only the READER — nobody is consuming its frames, and
// nobody will finalize the run when it produces its result. Everything needed to
// resume is durable (session-store.ts): containerId / sessionEndpoint /
// sessionSecret / frameCursor on the AiRun row.
//
// This module is the missing reader. On boot (instrumentation.ts, before the
// silence reaper) every RUNNING/PENDING run that still advertises a session is
// probed; a container that answers is re-attached, its unpersisted frames are
// replayed into the timeline exactly once from the persisted cursor, and its
// terminal result finalizes the run the same way the live path would.
//
// Deliberate non-goals:
//   * Adoption never reaps. An unreachable session is left exactly as it is —
//     judging a dead run is the silence reaper's job (lib/ai-runs.ts).
//   * Adoption never re-posts the job, so it cannot start a second agent turn.
//   * Adoption never reconstructs a workspace commit. See COMMIT below.
//   * Only CONVERSATION-shaped runs are finalized today (that is the Slack case
//     that matters); other trigger types are logged and left to the reaper.

import { finalizeConversationRun } from "@/lib/agent-conversation";
import { createLiveCommentRecorder } from "@/lib/agent-comments";
import { createDeferredHeartbeat, recordAiRunEvent } from "@/lib/ai-runs";
import { getDocumentPlainText, parseDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import { markdownToMrkdwn } from "@/lib/slack/mrkdwn";

import {
  attachDetachedSession,
  SessionAbortedError,
  type DetachedSessionHandle
} from "./container-session";
import {
  deregisterRunAbortController,
  isRunCancellation,
  registerRunAbortController,
  RUN_CANCELLED_MESSAGE
} from "./run-registry";
import { probeAgentSession } from "./session-client";
import { createAiRunSessionStore } from "./session-store";

/** Trigger types whose terminal bookkeeping is `finalizeConversationRun`. */
const CONVERSATION_TRIGGER_TYPES = new Set([
  "CONVERSATION",
  "CONVERSATION_FOLLOWUP",
  "SLACK_MENTION",
  "SLACK_FOLLOWUP"
]);

const SLACK_TRIGGER_TYPES = new Set(["SLACK_MENTION", "SLACK_FOLLOWUP"]);

export type SlackReplyDelivery = (args: {
  channel: string;
  threadTs: string;
  text: string;
}) => Promise<void>;

export type SessionAdoptionDeps = {
  /** Restrict the sweep to these run ids (tests; production sweeps everything). */
  runIds?: string[];
  probe?: (endpoint: string, secret: string) => Promise<boolean>;
  attach?: typeof attachDetachedSession;
  waitMs?: number;
  /** Injected in tests; production posts with the bot token. */
  deliverSlackReply?: SlackReplyDelivery;
};

export type SessionAdoptionSkip = {
  aiRunId: string;
  reason: "unreachable" | "in-flight" | "unsupported-trigger";
};

export type SessionAdoptionResult = {
  adopted: string[];
  skipped: SessionAdoptionSkip[];
  /**
   * Resolves when every adopted run has been driven to its terminal state.
   * Instrumentation ignores it (adoption must never block boot); tests await it.
   */
  settled: Promise<void>;
};

// Same reason the run registry lives on globalThis: Next evaluates
// instrumentation.ts in a different module context than route handlers, so a
// module-local set would let two contexts adopt the same container and
// double-persist its frames.
const ADOPTION_GLOBAL_KEY = Symbol.for("r-docs.agent-session-adoption");

type AdoptionGlobal = { inFlight: Set<string> };

function adoptionState(): AdoptionGlobal {
  const globalObject = globalThis as unknown as Record<symbol, AdoptionGlobal | undefined>;
  const existing = globalObject[ADOPTION_GLOBAL_KEY];
  if (existing) return existing;
  const created: AdoptionGlobal = { inFlight: new Set() };
  globalObject[ADOPTION_GLOBAL_KEY] = created;
  return created;
}

export function isAdoptionInFlight(aiRunId: string): boolean {
  return adoptionState().inFlight.has(aiRunId);
}

export function adoptionMessage(containerId: string | null): string {
  return `Adopted the running agent container${
    containerId ? ` ${containerId.slice(0, 12)}` : ""
  } after a server restart — this run continues in a new server process.`;
}

export function uncommittedWorkspaceMessage(workspacePath: string): string {
  return `The server restarted before this run's changes could be committed. They were left uncommitted in ${workspacePath} — no commit or push was made for this run.`;
}

export const SLACK_DELIVERY_UNAVAILABLE =
  "This run was adopted after a server restart, so its Slack reply could not be delivered to the original thread (the thread reference was not recorded). The reply is in this timeline.";

export async function adoptOrphanedSessions(
  deps?: SessionAdoptionDeps
): Promise<SessionAdoptionResult> {
  const state = adoptionState();
  const candidates = await db.aiRun.findMany({
    where: {
      ...(deps?.runIds ? { id: { in: deps.runIds } } : {}),
      status: { in: ["RUNNING", "PENDING"] },
      sessionEndpoint: { not: null },
      sessionSecret: { not: null }
    },
    select: {
      id: true,
      documentId: true,
      createdById: true,
      triggerType: true,
      triggerId: true,
      containerId: true,
      sessionEndpoint: true,
      sessionSecret: true,
      frameCursor: true,
      workspacePath: true
    }
  });

  const probe = deps?.probe ?? ((endpoint: string, secret: string) => probeAgentSession(endpoint, secret));
  const adopted: string[] = [];
  const skipped: SessionAdoptionSkip[] = [];
  const running: Array<Promise<void>> = [];

  for (const run of candidates) {
    if (!run.sessionEndpoint || !run.sessionSecret) continue;
    if (state.inFlight.has(run.id)) {
      skipped.push({ aiRunId: run.id, reason: "in-flight" });
      continue;
    }
    if (!CONVERSATION_TRIGGER_TYPES.has(run.triggerType)) {
      // Selection edits, ask-ai and comment-thread runs apply their result to the
      // document through their own terminal paths; adopting one without that
      // application would silently drop the edit. Left RUNNING for the reaper —
      // adding a trigger type here means giving it a finalizer, above.
      console.warn(
        `[agent-session] not adopting run ${run.id}: no adoption finalizer for trigger type ${run.triggerType}`
      );
      skipped.push({ aiRunId: run.id, reason: "unsupported-trigger" });
      continue;
    }
    const reachable = await probe(run.sessionEndpoint, run.sessionSecret).catch(() => false);
    if (!reachable) {
      // Leave the row alone: the silence reaper owns dead runs (and its own probe
      // decides whether to spare this one).
      skipped.push({ aiRunId: run.id, reason: "unreachable" });
      continue;
    }

    state.inFlight.add(run.id);
    adopted.push(run.id);
    running.push(
      driveAdoptedRun(
        {
          aiRunId: run.id,
          documentId: run.documentId,
          createdById: run.createdById,
          triggerType: run.triggerType,
          triggerId: run.triggerId,
          workspacePath: run.workspacePath,
          handle: {
            containerId: run.containerId ?? "",
            endpoint: run.sessionEndpoint,
            secret: run.sessionSecret
          },
          since: run.frameCursor ?? 0
        },
        deps
      ).finally(() => {
        state.inFlight.delete(run.id);
      })
    );
  }

  return {
    adopted,
    skipped,
    settled: Promise.all(running).then(() => undefined)
  };
}

type AdoptedRun = {
  aiRunId: string;
  documentId: string;
  createdById: string | null;
  triggerType: string;
  triggerId: string | null;
  workspacePath: string | null;
  handle: DetachedSessionHandle;
  since: number;
};

async function driveAdoptedRun(run: AdoptedRun, deps?: SessionAdoptionDeps): Promise<void> {
  const { aiRunId, documentId } = run;
  const heartbeat = createDeferredHeartbeat(aiRunId);
  // Register an abort controller so the UI's cancel button works against the
  // adopting process, exactly like a run this process started.
  const abort = registerRunAbortController(aiRunId);
  heartbeat.begin();

  try {
    await recordAiRunEvent({
      aiRunId,
      role: "system",
      message: adoptionMessage(run.handle.containerId || null)
    });

    const document = await db.document.findUnique({
      where: { id: documentId },
      select: { content: true, agentModel: true }
    });
    const documentText = document ? getDocumentPlainText(parseDocumentContent(document.content)) : "";
    const commentRecorder = createLiveCommentRecorder({
      documentId,
      aiRunId,
      createdById: run.createdById,
      model: null,
      documentText
    });

    const output = await (deps?.attach ?? attachDetachedSession)({
      handle: run.handle,
      // No job: the container already has one. Posting again could start a
      // second agent turn.
      since: run.since,
      waitMs: deps?.waitMs,
      signal: abort.signal,
      steerRunId: aiRunId,
      store: createAiRunSessionStore(aiRunId),
      sink: {
        onProgress: async (event) => {
          await Promise.all([
            db.aiRun.update({ where: { id: aiRunId }, data: { progress: event.message } }),
            recordAiRunEvent({ aiRunId, role: event.role ?? "agent", message: event.message })
          ]).catch(() => null);
        },
        onComment: commentRecorder.onComment,
        onSlackMessage: async (text) => {
          await deliverSlackReply(run, text, deps).catch(() => null);
        },
        onSessionId: async (sessionId) => {
          await db.aiRun.update({ where: { id: aiRunId }, data: { sdkSessionId: sessionId } }).catch(() => null);
        }
      }
    });

    // COMMIT: an adopted run's worktree cannot be committed safely. Re-deriving
    // the base workspace and remote would mean re-running the (heavy,
    // conflict-resolving, agent-spawning) workspace setup at boot, so rather
    // than invent a half-working commit we say plainly where the work is.
    if (run.workspacePath) {
      await recordAiRunEvent({
        aiRunId,
        role: "system",
        message: uncommittedWorkspaceMessage(run.workspacePath)
      }).catch(() => null);
    }

    const reply = await finalizeConversationRun({
      aiRunId,
      documentId,
      result: output as Parameters<typeof finalizeConversationRun>[0]["result"],
      commit: { commitSha: null, commitUrl: null },
      commentRecorder
    });

    if (SLACK_TRIGGER_TYPES.has(run.triggerType)) {
      const target = slackTargetFromTriggerId(run.triggerId);
      if (!target) {
        await recordAiRunEvent({ aiRunId, role: "system", message: SLACK_DELIVERY_UNAVAILABLE }).catch(() => null);
        console.warn(`[agent-session] adopted Slack run ${aiRunId} has no recoverable thread reference`);
      } else {
        await deliverSlackReply(run, reply, deps).catch(async (error) => {
          console.warn(
            `[agent-session] adopted Slack run ${aiRunId} reply delivery failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          await recordAiRunEvent({ aiRunId, role: "error", message: SLACK_DELIVERY_UNAVAILABLE }).catch(() => null);
        });
      }
    }
  } catch (error) {
    const failureMessage =
      error instanceof SessionAbortedError || isRunCancellation(error, abort.signal)
        ? RUN_CANCELLED_MESSAGE
        : error instanceof Error
          ? error.message
          : "Adopted agent run failed.";
    console.warn(`[agent-session] adopted run ${aiRunId} ended in failure: ${failureMessage}`);
    await recordAiRunEvent({ aiRunId, role: "error", message: failureMessage }).catch(() => null);
    await db.aiRun
      .update({
        where: { id: aiRunId },
        data: { status: "FAILED", error: failureMessage, finishedAt: new Date() }
      })
      .catch(() => null);
  } finally {
    deregisterRunAbortController(aiRunId);
    heartbeat.stop();
  }
}

/**
 * Slack runs persist their thread as `AiRun.triggerId` = "<channel>:<threadTs>"
 * (lib/slack/events.ts, same value used as the live reply target), which is the
 * only Slack identifier available to an adopting process.
 */
export function slackTargetFromTriggerId(
  triggerId: string | null
): { channel: string; threadTs: string } | null {
  if (!triggerId) return null;
  const separator = triggerId.indexOf(":");
  if (separator <= 0) return null;
  const channel = triggerId.slice(0, separator);
  const threadTs = triggerId.slice(separator + 1);
  if (!channel || !threadTs) return null;
  return { channel, threadTs };
}

async function deliverSlackReply(run: AdoptedRun, text: string, deps?: SessionAdoptionDeps) {
  const target = slackTargetFromTriggerId(run.triggerId);
  if (!target) return;
  const deliver = deps?.deliverSlackReply ?? defaultSlackDelivery;
  await deliver({ channel: target.channel, threadTs: target.threadTs, text });
}

const defaultSlackDelivery: SlackReplyDelivery = async ({ channel, threadTs, text }) => {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  if (!botToken) {
    throw new Error("SLACK_BOT_TOKEN is not configured");
  }
  const { createSlackWebClient } = await import("@/lib/slack/web");
  await createSlackWebClient(botToken).postMessage({
    channel,
    threadTs,
    text: markdownToMrkdwn(text)
  });
};
