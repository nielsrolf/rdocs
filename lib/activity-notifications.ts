import { db } from "@/lib/db";
import { createSlackWebClient, type SlackClient } from "@/lib/slack/web";

export type ActivityNotificationDeps = { slack: SlackClient; appUrl: string };

let cachedDeps: ActivityNotificationDeps | null = null;

function deps(): ActivityNotificationDeps | null {
  if (cachedDeps) return cachedDeps;
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) return null;
  cachedDeps = {
    slack: createSlackWebClient(token),
    appUrl: process.env.APP_URL?.trim() || "http://localhost:14141"
  };
  return cachedDeps;
}

async function linkedRecipients(
  userIds: string[],
  setting: "documentShareSlackNotifications" | "forumShareSlackNotifications"
) {
  if (userIds.length === 0) return [];
  const users = await db.user.findMany({
    where: { id: { in: [...new Set(userIds)] }, [setting]: true },
    select: {
      id: true,
      slackLinks: { select: { slackUserId: true }, orderBy: { createdAt: "asc" }, take: 1 }
    }
  });
  return users.flatMap((user) =>
    user.slackLinks[0] ? [{ userId: user.id, slackUserId: user.slackLinks[0].slackUserId }] : []
  );
}

async function postActivity(input: {
  userIds: string[];
  setting: "documentShareSlackNotifications" | "forumShareSlackNotifications";
  text: (appUrl: string) => string;
  deps?: ActivityNotificationDeps;
}) {
  try {
    const runtime = input.deps ?? deps();
    if (!runtime) return { notified: 0 };
    const recipients = await linkedRecipients(input.userIds, input.setting);
    let notified = 0;
    for (const recipient of recipients) {
      try {
        await runtime.slack.postMessage({ channel: recipient.slackUserId, text: input.text(runtime.appUrl) });
        notified++;
      } catch (error) {
        console.warn("[activity-notify] DM failed", {
          userId: recipient.userId,
          setting: input.setting,
          error: error instanceof Error ? error.message : error
        });
      }
    }
    return { notified };
  } catch (error) {
    console.error("[activity-notify] dispatch failed", {
      setting: input.setting,
      error: error instanceof Error ? error.message : error
    });
    return { notified: 0 };
  }
}

export async function notifyDocumentShared(input: {
  documentId: string;
  recipientUserIds: string[];
  sharedByLabel: string;
  deps?: ActivityNotificationDeps;
}) {
  const document = await db.document.findUnique({ where: { id: input.documentId }, select: { title: true } });
  if (!document) return { notified: 0 };
  return postActivity({
    userIds: input.recipientUserIds,
    setting: "documentShareSlackNotifications",
    deps: input.deps,
    text: (appUrl) =>
      `📄 *${input.sharedByLabel}* shared <${appUrl}/documents/${input.documentId}|${document.title || "a document"}> with you.`
  });
}

export async function resolveStandingAccessUserIds(documentId: string, excludeUserIds: string[] = []) {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: {
      ownerId: true,
      memberships: { select: { userId: true } },
      groupAccess: { select: { group: { select: { ownerId: true, members: { select: { userId: true } } } } } }
    }
  });
  if (!document) return [];
  const excluded = new Set(excludeUserIds);
  const ids = new Set<string>();
  for (const member of document.memberships) ids.add(member.userId);
  for (const access of document.groupAccess) {
    ids.add(access.group.ownerId);
    for (const member of access.group.members) ids.add(member.userId);
  }
  ids.delete(document.ownerId);
  for (const id of excluded) ids.delete(id);
  return [...ids];
}

export async function notifyForumItemShared(input: {
  documentId: string;
  sharedByLabel: string;
  recipientUserIds?: string[];
  deps?: ActivityNotificationDeps;
}) {
  const document = await db.document.findUnique({
    where: { id: input.documentId },
    select: { title: true, kind: true }
  });
  if (!document) return { notified: 0 };
  const userIds = input.recipientUserIds ?? (await resolveStandingAccessUserIds(input.documentId));
  const quicktake = document.kind === "quicktake";
  const path = quicktake ? `/forum/quicktakes/${input.documentId}` : `/forum/${input.documentId}`;
  return postActivity({
    userIds,
    setting: "forumShareSlackNotifications",
    deps: input.deps,
    text: (appUrl) =>
      `📰 *${input.sharedByLabel}* shared ${quicktake ? "a quick take" : "a forum post"} with you: <${appUrl}${path}|${document.title || (quicktake ? "Quick take" : "Forum post")}>.`
  });
}
