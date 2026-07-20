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

import { db } from "@/lib/db";
import { saveAttachmentToStore } from "@/lib/attachments";
import { defaultDocumentContent, serializeDocumentContent } from "@/lib/content";
import { copyOwnerDefaultSkillsToDocument } from "@/lib/document-skills";
import { recordAiRunEvent } from "@/lib/ai-runs";
import {
  runAgentConversationInBackground,
  type ConversationRunInput
} from "@/lib/agent-conversation";
import { createSlackLinkToken, createSlackToolsToken } from "@/lib/slack/link-token";
import { markdownToMrkdwn } from "@/lib/slack/mrkdwn";
import { RUN_CANCELLED_MESSAGE, cancelAiRun } from "@/lib/agent-runner/run-registry";
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

export type SlackEventDeps = {
  slack: SlackClient;
  appUrl: string;
  botUserId: string;
  // Injectable so tests can observe run inputs without running an agent.
  startRun?: (input: ConversationRunInput) => Promise<void>;
};

const MAX_INSTRUCTION_LENGTH = 8000;

// Socket Mode redelivers events that were not acked in time; Slack also
// retries. Best-effort in-memory dedupe (single-process deploy, see CLAUDE.md).
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

export function stripBotMention(text: string, botUserId: string) {
  return text
    .replaceAll(`<@${botUserId}>`, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function ensureSlackChannelDocument(input: {
  slackTeamId: string;
  slackChannelId: string;
  channelName: string | null;
  titleFallback?: string;
  userId: string;
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

  const document = await db.document.create({
    data: {
      ownerId: input.userId,
      kind: "slack_channel",
      slackTeamId: input.slackTeamId,
      slackChannelId: input.slackChannelId,
      title: input.channelName
        ? `#${input.channelName}`
        : input.titleFallback ?? `Slack channel ${input.slackChannelId}`,
      content: serializeDocumentContent(defaultDocumentContent)
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
// dropped, nothing races the active run. In-memory, single-process deploy.
type QueuedFollowUp = {
  userId: string;
  slackUserId: string;
  senderName: string;
  text: string;
  ts: string;
};
const queuedFollowUps = new Map<string, QueuedFollowUp[]>();

export function queuedFollowUpCount(aiRunId: string) {
  return queuedFollowUps.get(aiRunId)?.length ?? 0;
}

type StartSlackRunArgs = {
  deps: SlackEventDeps;
  surface: "mention" | "dm";
  document: { id: string; title: string; content: string; agentModel: string | null; agentEffort: string | null };
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
};

export async function startSlackConversationRun(args: StartSlackRunArgs): Promise<string> {
  const { deps, surface, document, channel, channelName, teamId, triggerId, replyThreadTs } = args;

  const aiRun = await db.aiRun.create({
    data: {
      documentId: document.id,
      triggerType: args.parentRunId ? "SLACK_FOLLOWUP" : "SLACK_MENTION",
      createdById: args.userId,
      triggerId,
      parentRunId: args.parentRunId,
      instruction: args.instruction,
      progress: "Starting Claude research agent from Slack.",
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
    agentConfig: { model: document.agentModel, effort: document.agentEffort },
    agentAccessMode: "workspace",
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
      for (const anchor of args.reactionAnchors) {
        await deps.slack.removeReaction({ channel, ts: anchor.ts, name: "eyes" }).catch(() => null);
        await deps.slack
          .addReaction({ channel, ts: anchor.ts, name: succeeded ? "white_check_mark" : "x" })
          .catch(() => null);
      }
      const text = succeeded
        ? markdownToMrkdwn(outcome.reply ?? "Done.")
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

async function handleIncomingSlackMessage(
  event: SlackIncomingMessage,
  deps: SlackEventDeps,
  surface: "mention" | "dm"
) {
  // Never respond to bot messages (including our own) — loop guard. Message
  // subtypes (edits, joins, deletions…) are not user prompts either.
  if (!event.user || event.botId || event.subtype) {
    return { handled: false as const, reason: "bot-message" as const };
  }
  if (hasSeenSlackEvent(event.eventId)) return { handled: false as const, reason: "duplicate" as const };

  const link = await db.slackAccountLink.findUnique({
    where: { slackTeamId_slackUserId: { slackTeamId: event.teamId, slackUserId: event.user } }
  });
  if (!link) {
    await sendConnectPrompt(event, deps, surface);
    return { handled: false as const, reason: "unlinked-user" as const };
  }

  const channelName = surface === "dm" ? null : (await deps.slack.channelInfo(event.channel))?.name ?? null;
  const dmTitle =
    surface === "dm"
      ? `Slack DM (${(await deps.slack.userInfo(event.user))?.displayName ?? event.user})`
      : undefined;
  const document = await ensureSlackChannelDocument({
    slackTeamId: event.teamId,
    slackChannelId: event.channel,
    channelName,
    titleFallback: dmTitle,
    userId: link.userId
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
  const activeRun = await db.aiRun.findFirst({
    where: {
      documentId: document.id,
      status: { in: ["RUNNING", "PENDING"] },
      triggerId
    },
    orderBy: { startedAt: "desc" },
    select: { id: true }
  });
  if (activeRun) {
    if (isInterruptMessage(instructionBody)) {
      const cancelled = cancelAiRun(activeRun.id);
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
    // Not an interrupt: queue for a follow-up run when the active one ends.
    const senderName = (await deps.slack.userInfo(event.user))?.displayName ?? event.user;
    const queue = queuedFollowUps.get(activeRun.id) ?? [];
    queue.push({
      userId: link.userId,
      slackUserId: event.user,
      senderName,
      text: instructionBody,
      ts: event.ts
    });
    queuedFollowUps.set(activeRun.id, queue);
    await deps.slack
      .addReaction({ channel: event.channel, ts: event.ts, name: "hourglass_flowing_sand" })
      .catch(() => null);
    // Race guard: if the run finished while we were queueing, its onFinished
    // may have already drained — re-check and drain-start ourselves if the run
    // is terminal and our message is still queued.
    const nowTerminal = await db.aiRun.findFirst({
      where: { id: activeRun.id, status: { in: ["SUCCEEDED", "FAILED"] } },
      select: { id: true }
    });
    if (!nowTerminal || queuedFollowUps.get(activeRun.id) !== queue) {
      return { handled: true as const, action: "queued" as const, aiRunId: activeRun.id };
    }
    queuedFollowUps.delete(activeRun.id);
  }

  const previousRun = await db.aiRun.findFirst({
    where: { documentId: document.id, triggerId, status: { in: ["SUCCEEDED", "FAILED"] } },
    orderBy: { startedAt: "desc" },
    select: { id: true }
  });

  // Files attached to the message: persisted as document attachments RIGHT
  // AWAY (Slack file URLs expire) — the existing worktree sync makes them
  // readable at attachments/<storedName> inside the agent's workspace.
  const savedFiles: string[] = [];
  for (const file of (event.files ?? []).slice(0, 5)) {
    if (!file.downloadUrl || !file.name) continue;
    const bytes = await deps.slack.downloadFile(file.downloadUrl);
    if (!bytes || bytes.length === 0 || bytes.length > 50 * 1024 * 1024) continue;
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
  const filesNote =
    savedFiles.length > 0
      ? `The user attached ${savedFiles.length === 1 ? "a file" : "files"}, available in your workspace:\n${savedFiles.map((f) => `- ${f}`).join("\n")}`
      : null;

  const threadContext = await buildThreadContext(deps, event);
  const instruction = [threadContext, filesNote, instructionBody]
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
    channelContext: await buildChannelContext(deps, event)
  });

  return { handled: true as const, aiRunId, documentId: document.id };
}

export async function handleSlackAppMention(event: SlackIncomingMessage, deps: SlackEventDeps) {
  return handleIncomingSlackMessage(event, deps, "mention");
}

// DMs: claudex responds to EVERY user message, no mention required.
export async function handleSlackDirectMessage(event: SlackIncomingMessage, deps: SlackEventDeps) {
  return handleIncomingSlackMessage(event, deps, "dm");
}
