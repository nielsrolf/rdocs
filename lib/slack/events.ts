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
import { defaultDocumentContent, serializeDocumentContent } from "@/lib/content";
import { copyOwnerDefaultSkillsToDocument } from "@/lib/document-skills";
import { recordAiRunEvent } from "@/lib/ai-runs";
import {
  runAgentConversationInBackground,
  type ConversationRunInput
} from "@/lib/agent-conversation";
import { createSlackLinkToken } from "@/lib/slack/link-token";
import type { SlackClient } from "@/lib/slack/web";

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

async function buildThreadContext(
  deps: SlackEventDeps,
  event: SlackIncomingMessage
): Promise<string | null> {
  if (!event.threadTs || event.threadTs === event.ts) return null;
  try {
    const replies = await deps.slack.threadReplies({ channel: event.channel, ts: event.threadTs, limit: 20 });
    const others = replies.filter((message) => message.ts !== event.ts && message.text);
    if (others.length === 0) return null;
    const lines = await Promise.all(
      others.slice(-15).map(async (message) => {
        const name = message.botId
          ? "claudex (you)"
          : message.user
            ? (await deps.slack.userInfo(message.user))?.displayName ?? message.user
            : "unknown";
        return `[${name}]: ${message.text}`;
      })
    );
    return `Recent messages in this Slack thread (for context):\n${lines.join("\n")}`;
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
  const previousRun = await db.aiRun.findFirst({
    where: { documentId: document.id, triggerId, status: { in: ["SUCCEEDED", "FAILED"] } },
    orderBy: { startedAt: "desc" },
    select: { id: true }
  });

  const instructionBody = stripBotMention(event.text, deps.botUserId) || "(no message)";
  const threadContext = await buildThreadContext(deps, event);
  const instruction = [threadContext, instructionBody]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_INSTRUCTION_LENGTH);

  const aiRun = await db.aiRun.create({
    data: {
      documentId: document.id,
      triggerType: previousRun ? "SLACK_FOLLOWUP" : "SLACK_MENTION",
      triggerId,
      parentRunId: previousRun?.id ?? null,
      instruction,
      progress: "Starting Claude research agent from Slack.",
      suggestOnly: true
    }
  });
  await recordAiRunEvent({ aiRunId: aiRun.id, role: "user", message: instruction });

  // Working indicator on the triggering message; runs can take minutes and
  // silence reads as a broken bot.
  await deps.slack.addReaction({ channel: event.channel, ts: event.ts, name: "eyes" }).catch(() => null);

  const replyThreadTs = event.threadTs ?? event.ts;

  const startRun = deps.startRun ?? runAgentConversationInBackground;
  const runInput: ConversationRunInput = {
    documentId: document.id,
    aiRunId: aiRun.id,
    message: instruction,
    previousRunId: previousRun?.id ?? null,
    documentTitle: document.title,
    documentContent: document.content,
    createdById: link.userId,
    agentConfig: { model: document.agentModel, effort: document.agentEffort },
    agentAccessMode: "workspace",
    onFinished: async (outcome) => {
      const succeeded = outcome.status === "SUCCEEDED";
      await deps.slack
        .removeReaction({ channel: event.channel, ts: event.ts, name: "eyes" })
        .catch(() => null);
      await deps.slack
        .addReaction({ channel: event.channel, ts: event.ts, name: succeeded ? "white_check_mark" : "x" })
        .catch(() => null);
      const text = succeeded
        ? outcome.reply ?? "Done."
        : `The run failed: ${outcome.error ?? "unknown error"}`;
      await deps.slack
        .postMessage({ channel: event.channel, threadTs: replyThreadTs, text })
        .catch((error) => {
          console.error("[slack] reply delivery failed", {
            aiRunId: aiRun.id,
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

  return { handled: true as const, aiRunId: aiRun.id, documentId: document.id };
}

export async function handleSlackAppMention(event: SlackIncomingMessage, deps: SlackEventDeps) {
  return handleIncomingSlackMessage(event, deps, "mention");
}

// DMs: claudex responds to EVERY user message, no mention required.
export async function handleSlackDirectMessage(event: SlackIncomingMessage, deps: SlackEventDeps) {
  return handleIncomingSlackMessage(event, deps, "dm");
}
