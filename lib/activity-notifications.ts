import { db } from "@/lib/db";
import { pickNotificationSlackLink, userDefaultCommentScope } from "@/lib/notification-preferences";
import type { SlackClient } from "@/lib/slack/web";
import { hasAnySlackInstallation, installedSlackTeamIds, slackTeamContext } from "@/lib/slack/installations";

export type ActivityNotificationDeps = {
  slack: SlackClient;
  appUrl: string;
  /** Workspace this client posts into; bounds the public-post broadcast. */
  botTeamId?: string | null;
};

// Safety valve for the one fan-out that is not bounded by document access.
const FORUM_BROADCAST_LIMIT = 500;

// Bot client for one recipient's workspace (multi-workspace installs). Tests
// inject `deps` instead, which then serves every recipient.
async function depsForTeam(teamId: string): Promise<ActivityNotificationDeps | null> {
  const context = await slackTeamContext(teamId);
  if (!context) return null;
  return { slack: context.slack, appUrl: context.appUrl, botTeamId: teamId };
}

async function linkedRecipients(
  userIds: string[],
  setting:
    | "documentShareSlackNotifications"
    | "forumShareSlackNotifications"
    | "forumPostSlackNotifications"
    | "commentSlackNotifications"
) {
  if (userIds.length === 0) return [];
  const users = await db.user.findMany({
    where: { id: { in: [...new Set(userIds)] } },
    select: {
      id: true,
      commentSlackNotifications: true,
      commentNotificationScope: true,
      documentShareSlackNotifications: true,
      forumShareSlackNotifications: true,
      forumPostSlackNotifications: true,
      notificationSlackTeamId: true,
      slackLinks: { select: { slackTeamId: true, slackUserId: true }, orderBy: { createdAt: "asc" } }
    }
  });
  return users.flatMap((user) => {
    // Mentions ride the comment scope: anything but "none" wants them, because
    // being @-mentioned is participation.
    const enabled =
      setting === "commentSlackNotifications"
        ? userDefaultCommentScope(user) !== "none"
        : user[setting];
    if (!enabled) return [];
    const link = pickNotificationSlackLink(user.slackLinks, user.notificationSlackTeamId);
    return link ? [{ userId: user.id, slackTeamId: link.slackTeamId, slackUserId: link.slackUserId }] : [];
  });
}

async function postActivity(input: {
  userIds: string[];
  setting:
    | "documentShareSlackNotifications"
    | "forumShareSlackNotifications"
    | "forumPostSlackNotifications"
    | "commentSlackNotifications";
  text: (appUrl: string) => string;
  deps?: ActivityNotificationDeps;
}) {
  try {
    if (!input.deps && !(await hasAnySlackInstallation())) return { notified: 0 };
    const recipients = await linkedRecipients(input.userIds, input.setting);
    let notified = 0;
    const depsByTeam = new Map<string, ActivityNotificationDeps | null>();
    for (const recipient of recipients) {
      try {
        let runtime = input.deps ?? depsByTeam.get(recipient.slackTeamId);
        if (runtime === undefined) {
          runtime = await depsForTeam(recipient.slackTeamId);
          depsByTeam.set(recipient.slackTeamId, runtime);
        }
        if (!runtime) continue;
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

export async function notifyForumMentioned(input: {
  documentId: string;
  recipientUserIds: string[];
  authorLabel: string;
  kind: "quicktake" | "comment";
  deps?: ActivityNotificationDeps;
}) {
  if (input.recipientUserIds.length === 0) return { notified: 0 };
  const path = input.kind === "quicktake"
    ? `/forum/quicktakes/${input.documentId}`
    : `/forum/${input.documentId}`;
  return postActivity({
    userIds: input.recipientUserIds,
    setting: "commentSlackNotifications",
    deps: input.deps,
    text: (appUrl) => `🔔 *${input.authorLabel}* mentioned you in a forum ${input.kind === "quicktake" ? "quick take" : "comment"}: <${appUrl}${path}|Open it>.`
  });
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

// Who should hear about a NEW forum item. A public item reaches everyone with a
// Slack link in the bot's own workspace (that is who can read it and who the bot
// can DM at all); a group-scoped one only reaches the people it was actually
// shared with. The author never gets their own post.
export async function resolveForumAudienceUserIds(
  documentId: string,
  options: { excludeUserIds?: string[]; slackTeamIds?: string[] | null } = {}
) {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: { ownerId: true, forumPublic: true }
  });
  if (!document) return [];
  const excluded = new Set([document.ownerId, ...(options.excludeUserIds ?? [])]);
  if (!document.forumPublic) {
    return (await resolveStandingAccessUserIds(documentId)).filter((id) => !excluded.has(id));
  }
  const users = await db.user.findMany({
    where: {
      slackLinks: {
        some: options.slackTeamIds && options.slackTeamIds.length > 0 ? { slackTeamId: { in: options.slackTeamIds } } : {}
      }
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: FORUM_BROADCAST_LIMIT + 1
  });
  const ids = users.map((user) => user.id).filter((id) => !excluded.has(id));
  if (ids.length > FORUM_BROADCAST_LIMIT) {
    console.warn("[activity-notify] public forum broadcast truncated", {
      documentId,
      limit: FORUM_BROADCAST_LIMIT,
      dropped: ids.length - FORUM_BROADCAST_LIMIT
    });
    return ids.slice(0, FORUM_BROADCAST_LIMIT);
  }
  return ids;
}

// A new forum post or quick take became visible to people. Gated on
// `forumPostSlackNotifications` (on by default; the bell on the forum and
// quick-takes pages turns it off).
export async function notifyForumItemShared(input: {
  documentId: string;
  sharedByLabel: string;
  recipientUserIds?: string[];
  deps?: ActivityNotificationDeps;
}) {
  const document = await db.document.findUnique({
    where: { id: input.documentId },
    select: { title: true, kind: true, quicktakeBody: true }
  });
  if (!document) return { notified: 0 };
  const userIds =
    input.recipientUserIds ??
    (await resolveForumAudienceUserIds(input.documentId, {
      slackTeamIds: input.deps ? (input.deps.botTeamId ? [input.deps.botTeamId] : null) : await installedSlackTeamIds()
    }));
  const quicktake = document.kind === "quicktake";
  const path = quicktake ? `/forum/quicktakes/${input.documentId}` : `/forum/${input.documentId}`;
  const label = quicktake
    ? (document.quicktakeBody ?? document.title ?? "Quick take").replace(/\s+/g, " ").trim().slice(0, 120) ||
      "Quick take"
    : document.title || "Forum post";
  return postActivity({
    userIds,
    setting: "forumPostSlackNotifications",
    deps: input.deps,
    text: (appUrl) =>
      `📰 *${input.sharedByLabel}* posted ${quicktake ? "a quick take" : "a forum post"}: <${appUrl}${path}|${label}>.`
  });
}
