// Emoji reactions on comments. The palette is fixed so the API can validate
// input and the UI can render a stable picker. Aggregation (raw rows -> per-emoji
// counts + "did I react") is a pure function so it's unit-testable and reusable
// on both the server (serialization) and any future client recompute.

export const REACTION_EMOJIS = ["👍", "👎", "❤️", "🎉", "😄", "😕", "🚀", "👀"] as const;

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === "string" && (REACTION_EMOJIS as readonly string[]).includes(value);
}

export type RawReaction = {
  emoji: string;
  userId: string;
  user?: { name: string } | null;
};

export type ReactionSummary = {
  emoji: string;
  count: number;
  /** True when the requesting user has this reaction on the comment. */
  reactedByMe: boolean;
  /** Display names of reactors, for a hover tooltip. */
  users: string[];
};

/**
 * Collapse raw reaction rows into one entry per emoji, ordered by the fixed
 * palette so the UI is stable. Emojis nobody used are omitted.
 */
export function aggregateReactions(
  rows: RawReaction[],
  currentUserId: string | null
): ReactionSummary[] {
  const byEmoji = new Map<string, ReactionSummary>();
  for (const row of rows) {
    let entry = byEmoji.get(row.emoji);
    if (!entry) {
      entry = { emoji: row.emoji, count: 0, reactedByMe: false, users: [] };
      byEmoji.set(row.emoji, entry);
    }
    entry.count += 1;
    if (row.user?.name) entry.users.push(row.user.name);
    if (currentUserId && row.userId === currentUserId) entry.reactedByMe = true;
  }

  return sortByPalette([...byEmoji.values()]);
}

function sortByPalette(entries: ReactionSummary[]): ReactionSummary[] {
  const order = new Map(REACTION_EMOJIS.map((emoji, index) => [emoji as string, index]));
  return entries.sort((a, b) => {
    const ai = order.get(a.emoji) ?? Number.MAX_SAFE_INTEGER;
    const bi = order.get(b.emoji) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

/**
 * Client-side optimistic toggle of the current user's reaction. Applying it
 * twice with the same arguments returns the original summary, so it doubles as
 * the rollback when a request fails. Pure — does not mutate the input.
 */
export function toggleReactionLocal(
  summaries: ReactionSummary[],
  emoji: string,
  myName: string
): ReactionSummary[] {
  const existing = summaries.find((s) => s.emoji === emoji);
  if (!existing) {
    return sortByPalette([...summaries, { emoji, count: 1, reactedByMe: true, users: [myName] }]);
  }
  if (existing.reactedByMe) {
    const nextUsers = [...existing.users];
    const idx = nextUsers.indexOf(myName);
    if (idx !== -1) nextUsers.splice(idx, 1);
    const nextCount = existing.count - 1;
    if (nextCount <= 0) {
      return sortByPalette(summaries.filter((s) => s.emoji !== emoji));
    }
    return sortByPalette(
      summaries.map((s) =>
        s.emoji === emoji ? { ...s, count: nextCount, reactedByMe: false, users: nextUsers } : s
      )
    );
  }
  return sortByPalette(
    summaries.map((s) =>
      s.emoji === emoji
        ? { ...s, count: s.count + 1, reactedByMe: true, users: [...s.users, myName] }
        : s
    )
  );
}
