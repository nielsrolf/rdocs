// Comment-notification scopes, shared by the dispatcher (lib/comment-notifications.ts),
// the settings API and the bell UI.
//
// A user has a global default (`User.commentNotificationScope`) and may override
// it per document / quick take (`DocumentNotificationPreference.commentScope`).
// The legacy booleans (`User.commentSlackNotifications`,
// `DocumentNotificationPreference.commentSlackNotifications`) are still written
// so a draining blue/green sibling running the old code keeps working; they are
// only READ as a fallback for rows written before this change.

export const COMMENT_NOTIFICATION_SCOPES = ["all", "participating", "none"] as const;
export type CommentNotificationScope = (typeof COMMENT_NOTIFICATION_SCOPES)[number];

export const DEFAULT_COMMENT_NOTIFICATION_SCOPE: CommentNotificationScope = "participating";

export function isCommentNotificationScope(value: unknown): value is CommentNotificationScope {
  return typeof value === "string" && (COMMENT_NOTIFICATION_SCOPES as readonly string[]).includes(value);
}

export function normalizeCommentNotificationScope(
  value: unknown,
  fallback: CommentNotificationScope = DEFAULT_COMMENT_NOTIFICATION_SCOPE
): CommentNotificationScope {
  return isCommentNotificationScope(value) ? value : fallback;
}

/** The user's global default, falling back to the legacy boolean for old rows. */
export function userDefaultCommentScope(user: {
  commentNotificationScope?: string | null;
  commentSlackNotifications?: boolean | null;
}): CommentNotificationScope {
  if (isCommentNotificationScope(user.commentNotificationScope)) return user.commentNotificationScope;
  if (user.commentSlackNotifications === false) return "none";
  return DEFAULT_COMMENT_NOTIFICATION_SCOPE;
}

/**
 * Effective scope for one user on one document. A per-document row always wins;
 * a row written before `commentScope` existed means "on" = subscribed to every
 * comment there, "off" = muted.
 */
export function effectiveCommentScope(input: {
  user: { commentNotificationScope?: string | null; commentSlackNotifications?: boolean | null };
  preference?: { commentScope?: string | null; commentSlackNotifications?: boolean | null } | null;
}): CommentNotificationScope {
  const preference = input.preference;
  if (preference) {
    if (isCommentNotificationScope(preference.commentScope)) return preference.commentScope;
    if (typeof preference.commentSlackNotifications === "boolean") {
      return preference.commentSlackNotifications ? "all" : "none";
    }
  }
  return userDefaultCommentScope(input.user);
}

/**
 * Does this scope want a DM for this comment?
 * `participating` covers: the document/quick take owner, whoever started the
 * thread, anyone who already commented in it, and anyone @-mentioned by it.
 */
export function scopeWantsNotification(
  scope: CommentNotificationScope,
  context: { participant: boolean; mentioned: boolean }
): boolean {
  if (scope === "none") return false;
  if (scope === "all") return true;
  return context.participant || context.mentioned;
}

/** The legacy boolean mirror written alongside a scope. */
export function legacyBooleanForScope(scope: CommentNotificationScope): boolean {
  return scope !== "none";
}

/**
 * The Slack identity that receives a user's DMs. Users linked in several
 * workspaces pick one in Settings → Notifications (`User.notificationSlackTeamId`);
 * without a pick, or when the picked link is gone, the oldest link wins.
 * `links` must be ordered oldest first.
 */
export function pickNotificationSlackLink<T extends { slackTeamId: string }>(
  links: readonly T[],
  preferredTeamId: string | null | undefined
): T | null {
  if (preferredTeamId) {
    const preferred = links.find((link) => link.slackTeamId === preferredTeamId);
    if (preferred) return preferred;
  }
  return links[0] ?? null;
}
