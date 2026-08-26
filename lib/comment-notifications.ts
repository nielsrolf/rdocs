// Slack DM notifications for document comments.
//
// Whenever a comment lands in a document thread (human reply, new thread, AI
// reply, MCP tool), every user who can see the document — owner, direct
// members, group members — and has BOTH a linked Slack account AND
// User.commentSlackNotifications enabled gets a DM. One Slack thread per
// (comment thread, recipient): the first notification is a root DM message
// (persisted as a SlackCommentNotification row); later comments in the same
// doc thread arrive as Slack thread replies under it. Replying in that Slack
// thread posts back into the doc's comment thread (see lib/slack/events.ts) —
// only an @claudex mention there triggers an AI run.
//
// Dispatch is strictly fire-and-forget: callers `void notifyCommentPosted(...)`
// after their own response is committed, and every failure is logged under the
// `[comment-notify]` scope, never thrown into the comment write path.

import { db } from "@/lib/db";
import { markdownToMrkdwn } from "@/lib/slack/mrkdwn";
import { createSlackWebClient, slackAuthTest, type SlackClient } from "@/lib/slack/web";

export type CommentNotifierDeps = {
  slack: SlackClient;
  appUrl: string;
  botUserId: string;
};

// Cached bot client for dispatches outside a Slack event context (HTTP comment
// routes, ask-ai background runs, MCP) — same pattern as lib/scheduler.ts.
let cachedDeps: CommentNotifierDeps | null = null;

async function buildNotifierDeps(): Promise<CommentNotifierDeps | null> {
  if (cachedDeps) return cachedDeps;
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  if (!botToken) return null;
  const auth = await slackAuthTest(botToken).catch(() => null);
  if (!auth?.userId) return null;
  cachedDeps = {
    slack: createSlackWebClient(botToken),
    appUrl: process.env.APP_URL?.trim() || "http://localhost:14141",
    botUserId: auth.userId
  };
  return cachedDeps;
}

export type CommentNotificationRecipient = {
  userId: string;
  slackTeamId: string;
  slackUserId: string;
};

// Everyone with standing access to the document (owner + direct memberships +
// members of groups the document is shared with), minus the author/excluded
// users, filtered to users who opted in (default on) and have a Slack link.
// Share-link visitors and forum-public readers are deliberately not notified —
// there is no bounded user set behind those.
export async function resolveCommentNotificationRecipients(input: {
  documentId: string;
  excludeUserIds?: Array<string | null | undefined>;
}): Promise<CommentNotificationRecipient[]> {
  const document = await db.document.findUnique({
    where: { id: input.documentId },
    select: {
      ownerId: true,
      memberships: { select: { userId: true } },
      groupAccess: {
        select: {
          group: { select: { ownerId: true, members: { select: { userId: true } } } }
        }
      }
    }
  });
  if (!document) return [];
  const excluded = new Set((input.excludeUserIds ?? []).filter(Boolean) as string[]);
  const candidateIds = new Set<string>([document.ownerId]);
  for (const membership of document.memberships) candidateIds.add(membership.userId);
  for (const access of document.groupAccess) {
    candidateIds.add(access.group.ownerId);
    for (const member of access.group.members) candidateIds.add(member.userId);
  }
  for (const id of excluded) candidateIds.delete(id);
  if (candidateIds.size === 0) return [];
  const users = await db.user.findMany({
    where: { id: { in: [...candidateIds] } },
    select: {
      id: true,
      commentSlackNotifications: true,
      documentNotificationPreferences: {
        where: { documentId: input.documentId },
        select: { commentSlackNotifications: true },
        take: 1
      },
      slackLinks: {
        select: { slackTeamId: true, slackUserId: true },
        orderBy: { createdAt: "asc" },
        take: 1
      }
    }
  });
  return users.flatMap((user) => {
    const enabled =
      user.documentNotificationPreferences[0]?.commentSlackNotifications ??
      user.commentSlackNotifications;
    if (!enabled) return [];
    const link = user.slackLinks[0];
    if (!link) return [];
    return [{ userId: user.id, slackTeamId: link.slackTeamId, slackUserId: link.slackUserId }];
  });
}

function clip(text: string, max: number) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

// Posts the DM notifications for one freshly created comment. Never throws.
export async function notifyCommentPosted(input: {
  threadId: string;
  documentId: string;
  commentBody: string;
  // Display label for the comment's author (user name, guest name, or model).
  authorLabel: string;
  // The author + anyone else who must not be notified (e.g. the Slack user
  // whose DM reply created this comment — they are literally looking at it).
  excludeUserIds?: Array<string | null | undefined>;
  // Injectable for tests and for reuse of an existing Slack event context.
  deps?: CommentNotifierDeps;
}): Promise<{ notified: number }> {
  try {
    const deps = input.deps ?? (await buildNotifierDeps());
    if (!deps) return { notified: 0 };
    const thread = await db.commentThread.findUnique({
      where: { id: input.threadId },
      select: {
        anchorText: true,
        document: { select: { id: true, title: true } }
      }
    });
    if (!thread) return { notified: 0 };
    const recipients = await resolveCommentNotificationRecipients({
      documentId: input.documentId,
      excludeUserIds: input.excludeUserIds
    });
    if (recipients.length === 0) return { notified: 0 };

    const docUrl = `${deps.appUrl}/documents/${thread.document.id}`;
    const body = clip(markdownToMrkdwn(input.commentBody), 1500);
    const quoted = body
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    const anchorNote = thread.anchorText ? `\nOn: “${clip(thread.anchorText, 160)}”` : "";
    const rootText =
      `💬 *${input.authorLabel}* commented on <${docUrl}|${clip(thread.document.title, 120) || "a document"}>` +
      `${anchorNote}\n${quoted}\n` +
      `_Reply in this thread to answer in the document — mention <@${deps.botUserId}> to bring in the AI._`;
    const replyText = `*${input.authorLabel}* replied:\n${quoted}`;

    let notified = 0;
    for (const recipient of recipients) {
      try {
        const existing = await db.slackCommentNotification.findUnique({
          where: { threadId_userId: { threadId: input.threadId, userId: recipient.userId } },
          select: { slackChannelId: true, messageTs: true }
        });
        if (existing) {
          await deps.slack.postMessage({
            channel: existing.slackChannelId,
            threadTs: existing.messageTs,
            text: replyText
          });
          notified++;
          continue;
        }
        // chat.postMessage accepts a user id as `channel` and opens/uses the
        // IM; the response's resolved channel is the D… id inbound events use.
        const posted = await deps.slack.postMessage({
          channel: recipient.slackUserId,
          text: rootText
        });
        if (!posted.ts || !posted.channel) {
          // Without the resolved IM channel we cannot route replies back, so
          // don't persist a row — the next comment posts a fresh root instead.
          console.warn("[comment-notify] root DM missing ts/channel; reply routing disabled for it", {
            threadId: input.threadId,
            userId: recipient.userId,
            hasTs: Boolean(posted.ts)
          });
          notified++;
          continue;
        }
        await db.slackCommentNotification.create({
          data: {
            slackTeamId: recipient.slackTeamId,
            slackChannelId: posted.channel,
            messageTs: posted.ts,
            threadId: input.threadId,
            documentId: input.documentId,
            userId: recipient.userId
          }
        });
        notified++;
      } catch (error) {
        console.warn("[comment-notify] DM failed", {
          threadId: input.threadId,
          userId: recipient.userId,
          error: error instanceof Error ? error.message : error
        });
      }
    }
    if (notified > 0) {
      console.log("[comment-notify] dispatched", {
        threadId: input.threadId,
        documentId: input.documentId,
        notified,
        recipients: recipients.length
      });
    }
    return { notified };
  } catch (error) {
    console.error("[comment-notify] dispatch failed", {
      threadId: input.threadId,
      error: error instanceof Error ? error.message : error
    });
    return { notified: 0 };
  }
}
