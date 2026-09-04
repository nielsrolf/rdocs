// Forum frontpage layout preference. Two values:
//   "unified" — full posts and quick takes interleaved in one hotness-ranked feed
//   "split"   — a quick takes section (newest 5, link to all) above the post list
// Signed-in users persist it on User.forumLayout; every visitor (signed-out
// included) also carries it in the FORUM_LAYOUT_COOKIE, which is what the
// page reads first so the choice applies immediately after the toggle.

export const FORUM_LAYOUTS = ["unified", "split"] as const;
export type ForumLayout = (typeof FORUM_LAYOUTS)[number];

export const DEFAULT_FORUM_LAYOUT: ForumLayout = "unified";
export const FORUM_LAYOUT_COOKIE = "forum_layout";
export const FORUM_LAYOUT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function isForumLayout(value: unknown): value is ForumLayout {
  return typeof value === "string" && (FORUM_LAYOUTS as readonly string[]).includes(value);
}

export function normalizeForumLayout(value: unknown): ForumLayout {
  return isForumLayout(value) ? value : DEFAULT_FORUM_LAYOUT;
}

// Cookie wins over the stored preference: the toggle writes both, and the
// cookie is the one guaranteed to reflect the most recent click on THIS
// browser (also the only source for signed-out visitors). A missing/garbage
// cookie falls back to the account setting, then the default.
export function resolveForumLayout(
  cookieValue: string | null | undefined,
  storedValue: string | null | undefined
): ForumLayout {
  if (isForumLayout(cookieValue)) return cookieValue;
  if (isForumLayout(storedValue)) return storedValue;
  return DEFAULT_FORUM_LAYOUT;
}
