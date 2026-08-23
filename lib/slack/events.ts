// Core Slack event handling — the testable seam between the Socket Mode
// transport (lib/slack/service.ts) and the shared conversation runner
// (lib/agent-conversation.ts).
//
// Model: one Document (kind "slack_channel") per Slack channel or DM, one
// AiRun per incoming message, chained via parentRunId within a conversation.
// A conversation is a Slack thread ("<channel>:<thread_ts>") — or, for
// unthreaded DM messages, the DM channel itself ("<channel>:dm") so a DM feels
// like one continuous chat. Runs execute with the SENDING user's identity
// (runnerUserId → their credentials), which is why an unlinked Slack user gets
// a connect prompt instead of a run.
//
// Progress UX: the bot reacts to the triggering message — 👀 while working,
// ✅ / ❌ when the run finishes — and posts the agent's reply as a message.

import { RUN_STARTED_SLACK } from "@/agent-core/lifecycle-messages";
import { broadcastDocumentEvent } from "@/lib/collaboration";
import { notifyCommentPosted } from "@/lib/comment-notifications";
import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { serializeComment } from "@/lib/document-data";
import { syncCommentMentions } from "@/lib/mention-data";
import {
  agentAccessModeForDocumentAccess,
  canCommentOnDocument,
  resolveDocumentAccess
} from "@/lib/permissions";
import { resolveAgentConfigForUser } from "@/lib/agent-defaults";
import { saveAttachmentToStore } from "@/lib/attachments";
import { copyOwnerDefaultSkillsToDocument } from "@/lib/document-skills";
import { recordAiRunEvent } from "@/lib/ai-runs";
import {
  runAgentConversationInBackground,
  type ConversationRunInput
} from "@/lib/agent-conversation";
import { createSlackLinkToken, createSlackToolsToken } from "@/lib/slack/link-token";
import { resolveHostDevDir } from "@/lib/slack/dev-mode";
import { markdownToMrkdwn } from "@/lib/slack/mrkdwn";
import { queuedFollowUps, steeredRunAnchors } from "@/lib/slack/thread-state";
import { RUN_CANCELLED_MESSAGE, cancelAiRun, injectRunMessage } from "@/lib/agent-runner/run-registry";
import type { SlackClient, SlackMessage } from "@/lib/slack/web";

export type SlackIncomingMessage = {
  eventId: string;
  teamId: string;
  channel: string;
  user: string | undefined;
  botId?: string;
  subtype?: string;
  text: string;
  ts: string;
  threadTs?: string;
  files?: Array<{ downloadUrl?: string; name?: string; mimetype?: string }>;
};

// Back-compat alias (transport + tests use the mention name).
export type SlackMentionEvent = SlackIncomingMessage & { type?: "app_mention" };

export type TranscribeResult = { text: string } | { unavailable: true } | { error: string };

export type SlackEventDeps = {
  slack: SlackClient;
  appUrl: string;
  botUserId: string;
  // Injectable so tests can observe run inputs without running an agent.
  startRun?: (input: ConversationRunInput) => Promise<void>;
  // Injectable steering hook (defaults to the process-local run registry) so
  // tests can drive both the "injected into the live run" and the
  // "backend can't steer -> queued" paths.
  injectRunMessage?: (aiRunId: string, text: string) => boolean;
  // Injectable Ask-AI starter for comment-notification DM replies that mention
  // the bot; default is startAskAiRunForThread (lib/ask-ai.ts).
  startAskAi?: (args: {
    threadId: string;
    userId: string;
    agentAccessMode: "workspace" | "read_only";
  }) => Promise<string | null>;
  // Injectable voice transcription; default resolves the triggering user's
  // OpenAI/LiteLLM credential (lib/slack/transcribe.ts).
  transcribe?: (args: {
    documentId: string;
    userId: string | null;
    bytes: Buffer;
    filename: string;
    mimetype: string;
  }) => Promise<TranscribeResult>;
};

async function defaultTranscribe(args: {
  documentId: string;
  userId: string | null;
  bytes: Buffer;
  filename: string;
  mimetype: string;
}): Promise<TranscribeResult> {
  const { resolveTranscriptionConfig, transcribeAudio } = await import("@/lib/slack/transcribe");
  const config = await resolveTranscriptionConfig(args.documentId, args.userId);
  if (!config) return { unavailable: true };
  try {
    return { text: await transcribeAudio(config, args) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "transcription failed" };
  }
}

const MAX_INSTRUCTION_LENGTH = 8000;

// Socket Mode redelivers events that were not acked in time; Slack also
// retries. In-memory dedupe is the fast path, but it is PER PROCESS — during
// blue/green overlap (or with a zombie process) two processes each hold a
// Slack socket, and on 2026-08-23 both started a run for the same message.
// `claimSlackMessageIdentity` below adds the cross-process claim in the DB.
const seenEventIds = new Map<string, number>();
const SEEN_EVENT_TTL_MS = 10 * 60 * 1000;

export function hasSeenSlackEvent(eventId: string, now = Date.now()) {
  for (const [id, at] of seenEventIds) {
    if (now - at > SEEN_EVENT_TTL_MS) seenEventIds.delete(id);
  }
  if (seenEventIds.has(eventId)) return true;
  seenEventIds.set(eventId, now);
  return false;
}

// Returns true when THIS process is the first anywhere to see the message
// identity; false for any duplicate (same process or a sibling process). The
// DB unique constraint on SlackEventClaim.id is the cross-process arbiter. A
// DB failure degrades to in-memory-only dedupe (handle the message rather
// than drop it) — losing dedupe is recoverable, losing a user message is not.
async function claimSlackMessageIdentity(key: string, now = Date.now()): Promise<boolean> {
  if (hasSeenSlackEvent(key, now)) return false;
  try {
    await db.slackEventClaim.create({ data: { id: key } });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" // unique constraint — another process claimed it
    ) {
      return false;
    }
    console.error("[slack] event claim write failed, in-memory dedupe only", {
      key,
      error: error instanceof Error ? error.message : error
    });
    return true;
  }
  // Opportunistic TTL sweep so the claim table stays small; never blocks.
  void db.slackEventClaim
    .deleteMany({ where: { createdAt: { lt: new Date(now - SEEN_EVENT_TTL_MS) } } })
    .catch(() => null);
  return true;
}

export function stripBotMention(text: string, botUserId: string) {
  return text
    .replaceAll(`<@${botUserId}>`, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Starter content for a fresh channel document — lands as the doc body so the
// web view is self-explanatory instead of an empty page.
export function slackChannelSeedContent(title: string, surface: "channel" | "dm") {
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const where = surface === "dm" ? "your claudex DM" : `the Slack ${title} channel`;
  return JSON.stringify({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: `${title} — claudex workspace` }] },
      paragraph(
        `This document backs ${where}. It is not a normal document — it is the bot's configuration and memory surface:`
      ),
      paragraph(
        "• Agent settings here (model, effort, skills, environment variables — see the agent button in the top bar) configure how claudex runs in this conversation."
      ),
      paragraph(
        "• Every Slack message that triggers claudex shows up as a run in the agent panel, with its full timeline."
      ),
      paragraph(
        "• Files shared in Slack are stored as attachments; the agent keeps its own notes in the workspace CLAUDE.md."
      ),
      paragraph(
        "You can also use this body as a shared notebook — the agent reads it on every run, so pinned context (goals, conventions, links) written here reaches it."
      )
    ]
  });
}

export async function ensureSlackChannelDocument(input: {
  slackTeamId: string;
  slackChannelId: string;
  channelName: string | null;
  titleFallback?: string;
  userId: string;
  surface?: "channel" | "dm";
}) {
  const existing = await db.document.findUnique({
    where: {
      slackTeamId_slackChannelId: {
        slackTeamId: input.slackTeamId,
        slackChannelId: input.slackChannelId
      }
    }
  });
  if (existing) {
    // Slack channel membership is the access source of truth: anyone who can
    // message the bot in the channel gets edit access to the channel document.
    if (existing.ownerId !== input.userId) {
      await db.documentMembership.upsert({
        where: { documentId_userId: { documentId: existing.id, userId: input.userId } },
        update: {},
        create: { documentId: existing.id, userId: input.userId, permission: "EDIT" }
      });
    }
    return existing;
  }

  const title = input.channelName
    ? `#${input.channelName}`
    : input.titleFallback ?? `Slack channel ${input.slackChannelId}`;
  const document = await db.document.create({
    data: {
      ownerId: input.userId,
      kind: "slack_channel",
      slackTeamId: input.slackTeamId,
      slackChannelId: input.slackChannelId,
      title,
      content: slackChannelSeedContent(title, input.surface ?? "channel")
    }
  });
  await copyOwnerDefaultSkillsToDocument(input.userId, document.id);
  return document;
}

async function formatTranscript(
  deps: SlackEventDeps,
  messages: SlackMessage[],
  excludeTs: string
): Promise<string | null> {
  const others = messages.filter((message) => message.ts !== excludeTs && message.text);
  if (others.length === 0) return null;
  const nameCache = new Map<string, string>();
  const lines = await Promise.all(
    others.slice(-15).map(async (message) => {
      let name = "unknown";
      if (message.botId) {
        name = "claudex (you)";
      } else if (message.user) {
        if (!nameCache.has(message.user)) {
          nameCache.set(
            message.user,
            (await deps.slack.userInfo(message.user))?.displayName ?? message.user
          );
        }
        name = nameCache.get(message.user)!;
      }
      return `[${name}]: ${message.text}`;
    })
  );
  return lines.join("\n");
}

async function buildChannelContext(
  deps: SlackEventDeps,
  event: SlackIncomingMessage
): Promise<string | null> {
  try {
    const history = await deps.slack.channelHistory({ channel: event.channel, limit: 30 });
    return await formatTranscript(deps, history, event.ts);
  } catch {
    return null;
  }
}

async function buildThreadContext(
  deps: SlackEventDeps,
  event: SlackIncomingMessage
): Promise<string | null> {
  if (!event.threadTs || event.threadTs === event.ts) return null;
  try {
    const replies = await deps.slack.threadReplies({ channel: event.channel, ts: event.threadTs, limit: 20 });
    const transcript = await formatTranscript(deps, replies, event.ts);
    return transcript ? `Recent messages in this Slack thread (for context):\n${transcript}` : null;
  } catch {
    return null;
  }
}

async function sendConnectPrompt(
  event: SlackIncomingMessage,
  deps: SlackEventDeps,
  surface: "mention" | "dm"
) {
  const token = await createSlackLinkToken({ slackTeamId: event.teamId, slackUserId: event.user! });
  const connectUrl = `${deps.appUrl.replace(/\/$/, "")}/api/slack/connect?token=${encodeURIComponent(token)}`;
  const text =
    `To use claudex, connect your Slack account to your rdocs account first (the agent runs with YOUR credentials):\n` +
    `1. Sign in at ${deps.appUrl}\n2. Then open: ${connectUrl}\n` +
    `The link is valid for 1 hour — message me again afterwards.`;
  const send =
    surface === "dm"
      ? deps.slack.postMessage({ channel: event.channel, text })
      : deps.slack.postEphemeral({ channel: event.channel, user: event.user!, threadTs: event.threadTs, text });
  await Promise.resolve(send).catch((error) => {
    console.error("[slack] connect prompt failed", {
      error: error instanceof Error ? error.message : error
    });
  });
}

// Bare "wait"/"stop"-style messages sent while a run is active in the same
// conversation abort that run instead of becoming a prompt.
const INTERRUPT_PATTERN = /^(wait|stop|cancel|halt|abort)[\s.!]*$/i;

export function isInterruptMessage(text: string) {
  return INTERRUPT_PATTERN.test(text.trim());
}

// Messages that arrive while a run is still working are queued (per active
// run) and become ONE follow-up run the moment it finishes — nothing is
// dropped, nothing races the active run. Messages that were STEERED into a live
// run instead still owe their ✅/❌ at the end of that run, so their Slack ts is
// appended to `steeredRunAnchors` and picked up by the run's onFinished.
//
// Both maps are in-memory but PROCESS-wide (globalThis-backed in
// ./thread-state), because the Slack socket and the App Router routes are
// separate module contexts — see the comment there.

/**
 * Frames a mid-run Slack message for the agent that is already working. The
 * harness delivers it as a normal user turn, so it needs to be self-describing:
 * without the framing the model tends to read it as a fresh, unrelated request.
 */
export function buildSteeringMessage(senderName: string, text: string) {
  return (
    `New Slack message from ${senderName}, sent while you are still working on this thread. ` +
    `Treat it as steering for the CURRENT task: adjust your plan if it changes what you should do, ` +
    `and acknowledge it in your final reply.\n\n${text}`
  );
}

/**
 * Try to deliver `text` into a live agent session of one Slack thread.
 *
 * INVARIANT: at most one active agent session per Slack thread. Anything that
 * wants to say something into a thread that is already working (a Slack
 * message, a scheduled-task firing) steers the running session instead of
 * starting a second run — stacked runs all park on the per-conversation
 * session lock and look hung.
 *
 * Returns the ids of the thread's active runs and which one (if any) accepted
 * the message. `steeredRunId === null` with a non-empty `activeRunIds` means
 * the thread is busy but not steerable — the caller must queue or skip, never
 * start a parallel run.
 */
export async function steerActiveThreadRun(args: {
  documentId: string;
  triggerId: string;
  text: string;
  /** Timeline message to record on the steered run (defaults to `text`). */
  timelineMessage?: string;
  inject?: (aiRunId: string, text: string) => boolean;
}): Promise<{ activeRunIds: string[]; steeredRunId: string | null }> {
  const activeRuns = await db.aiRun.findMany({
    where: { documentId: args.documentId, status: { in: ["RUNNING", "PENDING"] }, triggerId: args.triggerId },
    orderBy: { startedAt: "desc" },
    select: { id: true }
  });
  const activeRunIds = activeRuns.map((run) => run.id);
  if (activeRunIds.length === 0) {
    return { activeRunIds, steeredRunId: null };
  }
  const inject = args.inject ?? injectRunMessage;
  const steeredRunId = activeRunIds.find((id) => inject(id, args.text)) ?? null;
  if (steeredRunId) {
    await recordAiRunEvent({
      aiRunId: steeredRunId,
      role: "user",
      message: args.timelineMessage ?? args.text
    }).catch(() => null);
  }
  return { activeRunIds, steeredRunId };
}

/**
 * Deliver a message into a Slack thread that ALREADY has active runs, exactly as
 * an incoming Slack message is delivered: steer the live session when a backend
 * holds an open input channel for one of the thread's runs, otherwise ⏳-queue it
 * so it becomes one follow-up run when the active run ends.
 *
 * Returns null only in the race where the queued-behind run turned out to be
 * terminal already and nothing else drained the queue — the caller must then
 * start a fresh run itself (that is what handleIncomingSlackMessage does by
 * falling through).
 */
async function steerOrQueueThreadMessage(args: {
  deps: SlackEventDeps;
  channel: string;
  /** Slack ts of the message carrying the text — the reaction anchor. */
  anchorTs: string;
  senderName: string;
  /** Active runs of the thread, newest first. */
  activeRunIds: string[];
  text: string;
  userId: string;
  slackUserId: string;
}): Promise<{ action: "injected" | "queued"; aiRunId: string } | null> {
  const { deps, channel, anchorTs, senderName, activeRunIds, text } = args;
  // Preferred path: inject the message straight into the RUNNING agent
  // session, so it steers the work in progress instead of becoming a
  // separate run afterwards. Only backends that hold an open input channel
  // for the run (in-process / container, Claude harness) accept this; every
  // other case returns false and falls through to the queue below.
  const inject = deps.injectRunMessage ?? injectRunMessage;
  const steeringText = buildSteeringMessage(senderName, text);
  const steeredRunId = activeRunIds.find((id) => inject(id, steeringText)) ?? null;
  if (steeredRunId) {
    await recordAiRunEvent({
      aiRunId: steeredRunId,
      role: "user",
      message: text
    }).catch(() => null);
    const anchors = steeredRunAnchors.get(steeredRunId) ?? [];
    anchors.push({ ts: anchorTs });
    steeredRunAnchors.set(steeredRunId, anchors);
    await deps.slack.addReaction({ channel, ts: anchorTs, name: "eyes" }).catch(() => null);
    return { action: "injected", aiRunId: steeredRunId };
  }

  // Fallback: queue for a follow-up run when the active one ends.
  const primaryRunId = activeRunIds[0];
  const queue = queuedFollowUps.get(primaryRunId) ?? [];
  queue.push({
    userId: args.userId,
    slackUserId: args.slackUserId,
    senderName,
    text,
    ts: anchorTs
  });
  queuedFollowUps.set(primaryRunId, queue);
  await deps.slack
    .addReaction({ channel, ts: anchorTs, name: "hourglass_flowing_sand" })
    .catch(() => null);
  // Race guard: if the run finished while we were queueing, its onFinished
  // may have already drained — re-check and drain-start ourselves if the run
  // is terminal and our message is still queued.
  const nowTerminal = await db.aiRun.findFirst({
    where: { id: primaryRunId, status: { in: ["SUCCEEDED", "FAILED"] } },
    select: { id: true }
  });
  if (!nowTerminal || queuedFollowUps.get(primaryRunId) !== queue) {
    return { action: "queued", aiRunId: primaryRunId };
  }
  queuedFollowUps.delete(primaryRunId);
  return null;
}

type StartSlackRunArgs = {
  deps: SlackEventDeps;
  surface: "mention" | "dm";
  document: {
    id: string;
    title: string;
    content: string;
    agentModel: string | null;
    agentEffort: string | null;
    runnerMode: string;
  };
  channel: string;
  channelName: string | null;
  teamId: string;
  triggerId: string;
  replyThreadTs: string | undefined;
  /** Trigger messages to mark with 👀 now and ✅/❌ at the end. */
  reactionAnchors: Array<{ ts: string }>;
  instruction: string;
  userId: string;
  slackUserId: string;
  parentRunId: string | null;
  channelContext: string | null;
  /** True for drained-queue follow-ups: their anchors carry an ⏳ to clear. */
  clearPendingReaction?: boolean;
  /** Allowlisted dev channel: run unsandboxed on the host in this directory. */
  hostDevDir?: string | null;
};

export async function startSlackConversationRun(args: StartSlackRunArgs): Promise<string> {
  const { deps, surface, document, channel, channelName, teamId, triggerId, replyThreadTs } = args;
  // Doc agent-panel config -> triggering user's default -> app default
  // (shared resolver, see lib/agent-defaults.ts).
  const agentConfig = await resolveAgentConfigForUser(document, args.userId);

  const aiRun = await db.aiRun.create({
    data: {
      documentId: document.id,
      triggerType: args.parentRunId ? "SLACK_FOLLOWUP" : "SLACK_MENTION",
      createdById: args.userId,
      triggerId,
      parentRunId: args.parentRunId,
      instruction: args.instruction,
      progress: RUN_STARTED_SLACK,
      suggestOnly: true
    }
  });
  await recordAiRunEvent({ aiRunId: aiRun.id, role: "user", message: args.instruction });

  // Working indicator on the triggering message(s); runs can take minutes and
  // silence reads as a broken bot.
  for (const anchor of args.reactionAnchors) {
    if (args.clearPendingReaction) {
      await deps.slack
        .removeReaction({ channel, ts: anchor.ts, name: "hourglass_flowing_sand" })
        .catch(() => null);
    }
    await deps.slack.addReaction({ channel, ts: anchor.ts, name: "eyes" }).catch(() => null);
  }

  const startRun = deps.startRun ?? runAgentConversationInBackground;
  const runInput: ConversationRunInput = {
    documentId: document.id,
    aiRunId: aiRun.id,
    message: args.instruction,
    previousRunId: args.parentRunId,
    documentTitle: document.title,
    documentContent: document.content,
    createdById: args.userId,
    agentConfig,
    agentAccessMode: "workspace",
    runnerMode: document.runnerMode,
    hostDevDir: args.hostDevDir,
    slackContext: {
      surface: surface === "dm" ? "dm" : "channel",
      channelName,
      recentMessages: args.channelContext
    },
    // Read tools call back over HTTP with a token pinned to the SENDER's Slack
    // identity — the route re-checks channel membership on every call.
    slackTools: {
      // SLACK_AGENT_TOOLS_URL overrides for deployments where containers can't
      // reach APP_URL (e.g. use http://host.docker.internal:14141/api/slack/agent-tools).
      url:
        process.env.SLACK_AGENT_TOOLS_URL?.trim() ||
        `${deps.appUrl.replace(/\/$/, "")}/api/slack/agent-tools`,
      // rdocs document access, authenticated as the triggering user via the
      // same run token (accepted by /api/mcp).
      mcpUrl:
        process.env.SLACK_AGENT_MCP_URL?.trim() || `${deps.appUrl.replace(/\/$/, "")}/api/mcp`,
      token: await createSlackToolsToken({
        slackTeamId: teamId,
        slackUserId: args.slackUserId,
        aiRunId: aiRun.id
      })
    },
    // Interim updates the agent posts mid-run via post_slack_message.
    onSlackMessage: async (text) => {
      await deps.slack.postMessage({
        channel,
        threadTs: replyThreadTs,
        text: markdownToMrkdwn(text)
      });
    },
    onFinished: async (outcome) => {
      const succeeded = outcome.status === "SUCCEEDED";
      const cancelled = !succeeded && outcome.error === RUN_CANCELLED_MESSAGE;
      // Trigger message(s) plus any message that was steered into this run
      // while it was working — both get the run's terminal reaction.
      const steeredAnchors = steeredRunAnchors.get(aiRun.id) ?? [];
      steeredRunAnchors.delete(aiRun.id);
      for (const anchor of [...args.reactionAnchors, ...steeredAnchors]) {
        await deps.slack.removeReaction({ channel, ts: anchor.ts, name: "eyes" }).catch(() => null);
        await deps.slack
          .addReaction({ channel, ts: anchor.ts, name: succeeded ? "white_check_mark" : "x" })
          .catch(() => null);
      }
      // `?? "Done."` alone let an EMPTY reply string through — Slack rejects
      // chat.postMessage with `no_text` and the user silently gets no reply.
      const text = succeeded
        ? markdownToMrkdwn(outcome.reply?.trim() ? outcome.reply : "Done.")
        : cancelled
          ? "Stopped."
          : `The run failed: ${outcome.error ?? "unknown error"}`;
      await deps.slack.postMessage({ channel, threadTs: replyThreadTs, text }).catch((error) => {
        console.error("[slack] reply delivery failed", {
          aiRunId: aiRun.id,
          error: error instanceof Error ? error.message : error
        });
      });

      // Messages that arrived during the run become one chained follow-up run
      // (skipped after a cancellation — "wait" means the user wants the floor).
      const queued = queuedFollowUps.get(aiRun.id) ?? [];
      queuedFollowUps.delete(aiRun.id);
      if (queued.length === 0 || cancelled) return;
      const multipleSenders = new Set(queued.map((q) => q.userId)).size > 1;
      const instruction = queued
        .map((q) => (queued.length > 1 || multipleSenders ? `[${q.senderName}]: ${q.text}` : q.text))
        .join("\n")
        .slice(0, MAX_INSTRUCTION_LENGTH);
      const last = queued[queued.length - 1];
      await startSlackConversationRun({
        ...args,
        instruction,
        userId: last.userId,
        slackUserId: last.slackUserId,
        parentRunId: aiRun.id,
        reactionAnchors: queued.map((q) => ({ ts: q.ts })),
        clearPendingReaction: true
      }).catch((error) => {
        console.error("[slack] queued follow-up failed to start", {
          afterRunId: aiRun.id,
          error: error instanceof Error ? error.message : error
        });
      });
    }
  };

  void startRun(runInput).catch((error) => {
    console.error("[slack] background run threw", {
      documentId: document.id,
      aiRunId: aiRun.id,
      error: error instanceof Error ? error.message : error
    });
  });

  return aiRun.id;
}

export type SlackThreadDelivery = {
  /** "steered" = injected into a live run, "queued" = ⏳ follow-up, "started" = new run. */
  outcome: "steered" | "queued" | "started";
  aiRunId: string;
  documentId: string;
  /** The conversation key of the target thread ("<channel>:<threadTs>" without the channel). */
  threadTs: string;
};

/**
 * Deliver a message into ANY Slack thread as if a user had sent it there.
 *
 * This is the path behind the agent's `message_thread` tool (the "supervisor"
 * capability): the caller has already posted the message to Slack for humans to
 * see, and this routes it exactly like an incoming user message — steer the live
 * run of that thread, ⏳-queue behind an unsteerable one, or start a new
 * conversation run. Authorization is the CALLER's job (see assertReadable in
 * lib/slack/agent-tools.ts); this function only routes.
 */
export async function deliverSlackThreadMessage(args: {
  deps: SlackEventDeps;
  teamId: string;
  channel: string;
  /** Root ts of the target thread. Omit to start a new conversation there. */
  threadTs?: string;
  /** ts of the Slack message carrying this text (reaction anchor / new thread key). */
  anchorTs?: string;
  /** Who the message is from, as shown to the target agent. */
  senderName: string;
  /** Message body (steering framing is added by buildSteeringMessage). */
  text: string;
  /** Instruction for a fresh run; defaults to `text`. */
  instruction?: string;
  /** rdocs user the run executes as (its credentials are used). */
  userId: string;
  slackUserId: string;
}): Promise<SlackThreadDelivery> {
  const { deps, channel } = args;
  const conversationKey = args.threadTs ?? args.anchorTs;
  if (!conversationKey) {
    throw new Error("deliverSlackThreadMessage needs threadTs or anchorTs");
  }
  const surface = channel.startsWith("D") ? "dm" : "mention";
  const channelName = surface === "dm" ? null : (await deps.slack.channelInfo(channel))?.name ?? null;
  const user = await db.user.findUnique({ where: { id: args.userId }, select: { email: true } });
  const document = await ensureSlackChannelDocument({
    slackTeamId: args.teamId,
    slackChannelId: channel,
    channelName,
    userId: args.userId,
    surface: surface === "dm" ? "dm" : "channel"
  });
  const triggerId = `${channel}:${conversationKey}`;

  // One thread = one agent session: an existing session is steered, never raced.
  if (args.anchorTs) {
    const activeRuns = await db.aiRun.findMany({
      where: { documentId: document.id, status: { in: ["RUNNING", "PENDING"] }, triggerId },
      orderBy: { startedAt: "desc" },
      select: { id: true }
    });
    if (activeRuns.length > 0) {
      const delivered = await steerOrQueueThreadMessage({
        deps,
        channel,
        anchorTs: args.anchorTs,
        senderName: args.senderName,
        activeRunIds: activeRuns.map((run) => run.id),
        text: args.text,
        userId: args.userId,
        slackUserId: args.slackUserId
      });
      if (delivered) {
        return {
          outcome: delivered.action === "injected" ? "steered" : "queued",
          aiRunId: delivered.aiRunId,
          documentId: document.id,
          threadTs: conversationKey
        };
      }
    }
  }

  const previousRun = await db.aiRun.findFirst({
    where: { documentId: document.id, triggerId, status: { in: ["SUCCEEDED", "FAILED"] } },
    orderBy: { startedAt: "desc" },
    select: { id: true }
  });
  const aiRunId = await startSlackConversationRun({
    deps,
    surface,
    document,
    channel,
    channelName,
    teamId: args.teamId,
    triggerId,
    replyThreadTs: conversationKey,
    reactionAnchors: args.anchorTs ? [{ ts: args.anchorTs }] : [],
    instruction: (args.instruction ?? args.text).slice(0, MAX_INSTRUCTION_LENGTH),
    userId: args.userId,
    slackUserId: args.slackUserId,
    parentRunId: previousRun?.id ?? null,
    channelContext: null,
    hostDevDir: resolveHostDevDir(channel, channelName, user?.email ?? "")
  });
  return { outcome: "started", aiRunId, documentId: document.id, threadTs: conversationKey };
}

/**
 * A DM reply inside a comment-notification thread posts back into the doc's
 * comment thread as the USER, never as an agent run — unless the reply
 * mentions the bot, which additionally triggers the same Ask-AI run the
 * document's "Ask AI" button would (the AI's reply then flows back to every
 * watcher's Slack thread through the notifier).
 *
 * Exported for tests; production reaches it through handleSlackDirectMessage
 * (the notification lookup in handleIncomingSlackMessage).
 */
export async function handleCommentNotificationReply(args: {
  event: SlackIncomingMessage;
  deps: SlackEventDeps;
  userId: string;
  notification: { threadId: string; documentId: string };
}) {
  const { event, deps, userId, notification } = args;
  const react = (name: string) =>
    deps.slack.addReaction({ channel: event.channel, ts: event.ts, name }).catch(() => null);

  const thread = await db.commentThread.findUnique({
    where: { id: notification.threadId },
    select: { id: true, documentId: true }
  });
  if (!thread) {
    await react("x");
    await deps.slack
      .postMessage({
        channel: event.channel,
        threadTs: event.threadTs,
        text: "That comment thread no longer exists, so I couldn't post your reply."
      })
      .catch(() => null);
    return { handled: true as const, action: "comment-thread-gone" as const };
  }
  const access = await resolveDocumentAccess(thread.documentId, userId);
  if (!access || !canCommentOnDocument(access, true)) {
    await react("x");
    await deps.slack
      .postMessage({
        channel: event.channel,
        threadTs: event.threadTs,
        text: "You no longer have comment access to that document, so I couldn't post your reply."
      })
      .catch(() => null);
    return { handled: true as const, action: "comment-access-denied" as const };
  }

  const mentionsBot = event.text.includes(`<@${deps.botUserId}>`);
  const body = stripBotMention(event.text, deps.botUserId);
  if (!body && !mentionsBot) {
    return { handled: false as const, reason: "empty-comment-reply" as const };
  }

  let commentId: string | null = null;
  if (body) {
    const comment = await db.comment.create({
      data: { threadId: thread.id, body, authorId: userId },
      select: {
        id: true,
        body: true,
        aiModel: true,
        guestName: true,
        sourceLinks: true,
        commitSha: true,
        commitUrl: true,
        aiRunId: true,
        createdAt: true,
        author: { select: { id: true, name: true } }
      }
    });
    commentId = comment.id;
    const now = new Date();
    await db.commentThread.update({ where: { id: thread.id }, data: { updatedAt: now } });
    await db.commentThreadRead.upsert({
      where: { threadId_userId: { threadId: thread.id, userId } },
      create: { threadId: thread.id, userId, lastReadAt: now },
      update: { lastReadAt: now }
    });
    await syncCommentMentions({
      commentId: comment.id,
      documentId: thread.documentId,
      body,
      authorId: userId
    });
    broadcastDocumentEvent(thread.documentId, "comment-created", {
      threadId: thread.id,
      comment: serializeComment(comment)
    });
    // Fan the reply out to the OTHER watchers' Slack threads (the author is
    // literally typing in theirs).
    void notifyCommentPosted({
      threadId: thread.id,
      documentId: thread.documentId,
      commentBody: body,
      authorLabel: comment.author?.name ?? "Someone",
      excludeUserIds: [userId],
      deps: { slack: deps.slack, appUrl: deps.appUrl, botUserId: deps.botUserId }
    });
    console.log("[comment-notify] DM reply posted as comment", {
      threadId: thread.id,
      documentId: thread.documentId,
      userId,
      commentId: comment.id,
      mentionsBot
    });
  }

  if (mentionsBot) {
    const startAskAi =
      deps.startAskAi ??
      (async (input: { threadId: string; userId: string; agentAccessMode: "workspace" | "read_only" }) => {
        const { startAskAiRunForThread } = await import("@/lib/ask-ai");
        return startAskAiRunForThread(input);
      });
    const aiRunId = await startAskAi({
      threadId: thread.id,
      userId,
      agentAccessMode: agentAccessModeForDocumentAccess(access)
    });
    await react(aiRunId ? "eyes" : "x");
    return {
      handled: true as const,
      action: "comment-reply-ask-ai" as const,
      commentId,
      aiRunId
    };
  }

  await react("speech_balloon");
  return { handled: true as const, action: "comment-reply" as const, commentId };
}

async function handleIncomingSlackMessage(
  event: SlackIncomingMessage,
  deps: SlackEventDeps,
  surface: "mention" | "dm"
) {
  // Never respond to bot messages (including our own) — loop guard. Message
  // subtypes (edits, joins, deletions…) are not user prompts either — EXCEPT
  // "file_share": that's how a normal user message with an attached file or
  // voice note arrives.
  if (!event.user || event.botId || (event.subtype && event.subtype !== "file_share")) {
    return { handled: false as const, reason: "bot-message" as const };
  }
  // Dedupe on the MESSAGE identity (team:channel:ts), not the event id: the
  // same message can arrive twice (app_mention + message.channels), and Slack
  // also redelivers unacked envelopes. The claim is DB-backed so a sibling
  // process (blue/green overlap) cannot start a second run for the same message.
  if (!(await claimSlackMessageIdentity(`${event.teamId}:${event.channel}:${event.ts}`))) {
    return { handled: false as const, reason: "duplicate" as const };
  }

  const link = await db.slackAccountLink.findUnique({
    where: { slackTeamId_slackUserId: { slackTeamId: event.teamId, slackUserId: event.user } },
    include: { user: { select: { email: true } } }
  });
  if (!link) {
    await sendConnectPrompt(event, deps, surface);
    return { handled: false as const, reason: "unlinked-user" as const };
  }
  // Comment-notification DM threads are NOT agent conversations: a reply under
  // one of our comment-notification root messages goes back into the document's
  // comment thread as the user (agent run only on an explicit bot mention).
  if (surface === "dm" && event.threadTs && event.threadTs !== event.ts) {
    const notification = await db.slackCommentNotification.findUnique({
      where: {
        slackChannelId_messageTs: { slackChannelId: event.channel, messageTs: event.threadTs }
      },
      select: { threadId: true, documentId: true }
    });
    if (notification) {
      return handleCommentNotificationReply({ event, deps, userId: link.userId, notification });
    }
  }

  const channelName = surface === "dm" ? null : (await deps.slack.channelInfo(event.channel))?.name ?? null;

  // Host dev mode: allowlisted channel + allowlisted user → the run executes
  // unsandboxed in a host directory (lib/slack/dev-mode.ts).
  const hostDevDir = resolveHostDevDir(event.channel, channelName, link.user.email);

  const dmTitle =
    surface === "dm"
      ? `Slack DM (${(await deps.slack.userInfo(event.user))?.displayName ?? event.user})`
      : undefined;
  const document = await ensureSlackChannelDocument({
    slackTeamId: event.teamId,
    slackChannelId: event.channel,
    channelName,
    titleFallback: dmTitle,
    userId: link.userId,
    surface: surface === "dm" ? "dm" : "channel"
  });

  // One Slack thread = one conversation, in channels and DMs alike: replies
  // are threaded off the triggering message, so the thread visibly IS the
  // context the agent has. A new top-level message starts a fresh conversation.
  const conversationKey = event.threadTs ?? event.ts;
  const triggerId = `${event.channel}:${conversationKey}`;
  const instructionBody = stripBotMention(event.text, deps.botUserId) || "(no message)";

  // Active-run handling is strictly THREAD-scoped, in channels and DMs alike:
  // one Slack thread = one agent session, and sessions in different threads
  // run in parallel without interfering. Only a message inside a session's own
  // thread can interrupt ("wait") or queue behind it.
  // ALL active runs of the thread, newest first — not just the newest one. A
  // thread can transiently hold more than one active row (a scheduled firing,
  // a chained follow-up), and all but one of them are typically parked on the
  // per-conversation session lock with no open input channel. Considering only
  // the newest meant a follow-up got ⏳-queued behind a run that could not
  // progress, even though another run in the same thread was steerable.
  const activeRuns = await db.aiRun.findMany({
    where: {
      documentId: document.id,
      status: { in: ["RUNNING", "PENDING"] },
      triggerId
    },
    orderBy: { startedAt: "desc" },
    select: { id: true }
  });
  const activeRun = activeRuns[0];
  if (activeRun) {
    if (isInterruptMessage(instructionBody)) {
      // "wait"/"stop" means the whole thread stops, so cancel every active run
      // in it — leaving a stacked sibling alive would keep working invisibly.
      const cancelled = activeRuns.map((run) => cancelAiRun(run.id)).some(Boolean);
      await deps.slack
        .addReaction({ channel: event.channel, ts: event.ts, name: cancelled ? "octagonal_sign" : "shrug" })
        .catch(() => null);
      if (!cancelled) {
        await deps.slack
          .postMessage({
            channel: event.channel,
            threadTs: event.threadTs ?? event.ts,
            text: "That run is no longer cancellable from here (it may have just finished)."
          })
          .catch(() => null);
      }
      return { handled: true as const, action: "interrupted" as const, aiRunId: activeRun.id };
    }
    const senderName = (await deps.slack.userInfo(event.user))?.displayName ?? event.user;

    const delivered = await steerOrQueueThreadMessage({
      deps,
      channel: event.channel,
      anchorTs: event.ts,
      senderName,
      activeRunIds: activeRuns.map((run) => run.id),
      text: instructionBody,
      userId: link.userId,
      slackUserId: event.user
    });
    if (delivered) {
      return { handled: true as const, action: delivered.action, aiRunId: delivered.aiRunId };
    }
  }

  const previousRun = await db.aiRun.findFirst({
    where: { documentId: document.id, triggerId, status: { in: ["SUCCEEDED", "FAILED"] } },
    orderBy: { startedAt: "desc" },
    select: { id: true, sdkSessionId: true }
  });

  // Files attached to the message: persisted as document attachments RIGHT
  // AWAY (Slack file URLs expire) — the existing worktree sync makes them
  // readable at attachments/<storedName> inside the agent's workspace. Voice
  // notes are additionally transcribed (with the triggering user's OpenAI or
  // LiteLLM credential) so they act like typed messages.
  const savedFiles: string[] = [];
  const transcripts: string[] = [];
  const voiceNotes: string[] = [];
  let voiceUnavailable = false;
  const transcribe = deps.transcribe ?? defaultTranscribe;
  for (const file of (event.files ?? []).slice(0, 5)) {
    if (!file.downloadUrl || !file.name) continue;
    const bytes = await deps.slack.downloadFile(file.downloadUrl);
    if (!bytes || bytes.length === 0 || bytes.length > 50 * 1024 * 1024) continue;
    const isAudio = (file.mimetype ?? "").startsWith("audio/");
    if (isAudio) {
      const result = await transcribe({
        documentId: document.id,
        userId: link.userId,
        bytes,
        filename: file.name,
        mimetype: file.mimetype ?? "audio/mp4"
      });
      if ("text" in result && result.text) {
        transcripts.push(result.text);
      } else if ("unavailable" in result) {
        voiceUnavailable = true;
      } else if ("error" in result) {
        voiceNotes.push(`(A voice message could not be transcribed: ${result.error})`);
      }
      continue;
    }
    try {
      const { storedName } = await saveAttachmentToStore(document.id, file.name, bytes);
      await db.attachment.create({
        data: {
          documentId: document.id,
          fileName: file.name,
          storedName,
          mimeType: file.mimetype ?? "application/octet-stream",
          size: bytes.length,
          createdById: link.userId
        }
      });
      savedFiles.push(`attachments/${storedName} (original name: ${file.name})`);
    } catch (error) {
      console.error("[slack] attachment save failed", {
        documentId: document.id,
        error: error instanceof Error ? error.message : error
      });
    }
  }
  const hasTypedText = instructionBody !== "(no message)";

  // A pure voice message with no way to transcribe it: don't burn an agent
  // run on guessing — tell the user how to enable voice support.
  if (voiceUnavailable && !hasTypedText && transcripts.length === 0 && savedFiles.length === 0) {
    const { VOICE_SUPPORT_HINT } = await import("@/lib/slack/transcribe");
    await deps.slack
      .postMessage({ channel: event.channel, threadTs: event.threadTs ?? event.ts, text: VOICE_SUPPORT_HINT })
      .catch(() => null);
    return { handled: false as const, reason: "voice-unavailable" as const };
  }
  if (voiceUnavailable) {
    voiceNotes.push(
      "(The user also sent a voice message, but no transcription credential is connected — mention that adding an OpenAI API key in rdocs enables voice support.)"
    );
  }

  const filesNote =
    savedFiles.length > 0
      ? `The user attached ${savedFiles.length === 1 ? "a file" : "files"}, available in your workspace:\n${savedFiles.map((f) => `- ${f}`).join("\n")}`
      : null;
  const transcriptNote =
    transcripts.length > 0
      ? hasTypedText
        ? `Voice message transcript${transcripts.length > 1 ? "s" : ""}:\n${transcripts.map((t) => `"${t}"`).join("\n")}`
        : null
      : null;
  // A voice-only message: the transcript IS the user's message.
  const effectiveBody = !hasTypedText && transcripts.length > 0 ? transcripts.join("\n") : instructionBody;

  // The user's message (plus notes about attachments/voice) must ALWAYS
  // survive the length cap — only the prepended thread context is expendable.
  // A plain tail-slice on the joined string used to silently drop the new
  // message whenever an earlier (long) bot reply filled the cap, so follow-up
  // runs received only replayed context and no question at all.
  const messagePart = [filesNote, transcriptNote, ...voiceNotes, effectiveBody]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_INSTRUCTION_LENGTH);
  // A follow-up that will resume the previous run's SDK session needs no
  // replayed thread transcript — the model already has the whole conversation
  // (messages AND tool calls) in its resumed context. (If the resume later
  // falls back — missing/GC'd transcript — the runner replays the AiRunEvent
  // history instead, which covers the same ground.)
  const threadContext = previousRun?.sdkSessionId ? null : await buildThreadContext(deps, event);
  const contextBudget = MAX_INSTRUCTION_LENGTH - messagePart.length - 2;
  const trimmedContext =
    threadContext && threadContext.length > contextBudget
      ? contextBudget > 400
        ? `Recent messages in this Slack thread (older/longer messages omitted for length):\n…${threadContext.slice(threadContext.length - contextBudget + 100)}`
        : null
      : threadContext;
  const instruction = [trimmedContext, messagePart]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_INSTRUCTION_LENGTH);

  const aiRunId = await startSlackConversationRun({
    deps,
    surface,
    document,
    channel: event.channel,
    channelName,
    teamId: event.teamId,
    triggerId,
    replyThreadTs: event.threadTs ?? event.ts,
    reactionAnchors: [{ ts: event.ts }],
    instruction,
    userId: link.userId,
    slackUserId: event.user,
    parentRunId: previousRun?.id ?? null,
    channelContext: await buildChannelContext(deps, event),
    hostDevDir
  });

  return { handled: true as const, aiRunId, documentId: document.id };
}

export async function handleSlackAppMention(event: SlackIncomingMessage, deps: SlackEventDeps) {
  return handleIncomingSlackMessage(event, deps, "mention");
}

// Channel thread replies WITHOUT a mention: once a thread is a claudex
// conversation, plain replies in it reach the bot too — that's what makes
// "wait" (and follow-ups) work without re-mentioning. Random threads that
// never involved claudex are ignored.
export async function handleSlackThreadReply(event: SlackIncomingMessage, deps: SlackEventDeps) {
  if (!event.threadTs || event.threadTs === event.ts) {
    return { handled: false as const, reason: "not-a-thread-reply" as const };
  }
  if (!event.user || event.botId || (event.subtype && event.subtype !== "file_share")) {
    return { handled: false as const, reason: "bot-message" as const };
  }
  const document = await db.document.findUnique({
    where: {
      slackTeamId_slackChannelId: { slackTeamId: event.teamId, slackChannelId: event.channel }
    },
    select: { id: true }
  });
  if (!document) return { handled: false as const, reason: "no-session" as const };
  const session = await db.aiRun.findFirst({
    where: { documentId: document.id, triggerId: `${event.channel}:${event.threadTs}` },
    select: { id: true }
  });
  if (!session) return { handled: false as const, reason: "no-session" as const };
  return handleIncomingSlackMessage(event, deps, "mention");
}

// DMs: claudex responds to EVERY user message, no mention required.
export async function handleSlackDirectMessage(event: SlackIncomingMessage, deps: SlackEventDeps) {
  return handleIncomingSlackMessage(event, deps, "dm");
}
