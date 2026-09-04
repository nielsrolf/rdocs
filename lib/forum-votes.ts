import { db } from "@/lib/db";

// The two LessWrong-style vote axes. "karma" is the general up/down vote that
// ranks the feed; "agreement" is agree/disagree and deliberately does NOT feed
// hotness — you can upvote a well-argued take you disagree with.
export const VOTE_KINDS = ["karma", "agreement"] as const;
export type VoteKind = (typeof VOTE_KINDS)[number];
export const DEFAULT_VOTE_KIND: VoteKind = "karma";

// A normal vote weighs ±1. Holding the karma button casts a LessWrong-style
// STRONG vote worth ±STRONG_VOTE_WEIGHT (stored as the weight itself, so tallies
// stay a plain sum and `ownVote` tells the UI which strength is active). Only
// the karma axis has strong votes; agreement is always ±1.
export const STRONG_VOTE_WEIGHT = 3;
export type VoteValue = 1 | -1 | typeof STRONG_VOTE_WEIGHT | -3;

export function allowedVoteValues(kind: VoteKind): readonly number[] {
  return kind === "karma" ? [0, 1, -1, STRONG_VOTE_WEIGHT, -STRONG_VOTE_WEIGHT] : [0, 1, -1];
}

export function isAllowedVoteValue(kind: VoteKind, value: number): value is VoteValue | 0 {
  return allowedVoteValues(kind).includes(value);
}

export function isStrongVote(value: number): boolean {
  return Math.abs(value) === STRONG_VOTE_WEIGHT;
}

export type VoteRow = { userId: string; kind: string; value: number };

// Per-target tally as the forum surfaces expose it. `score`/`ownVote` keep
// their historical names (karma) so existing callers and MCP output are
// unchanged; the agreement axis is additive.
export type VoteTally = {
  score: number;
  ownVote: number;
  agreement: number;
  ownAgreement: number;
};

export const EMPTY_TALLY: VoteTally = { score: 0, ownVote: 0, agreement: 0, ownAgreement: 0 };

export function isVoteKind(value: unknown): value is VoteKind {
  return typeof value === "string" && (VOTE_KINDS as readonly string[]).includes(value);
}

// Folds one target's vote rows into a tally. Unknown kinds are ignored rather
// than counted as karma. Pure so it can be unit-tested and reused by every
// list/detail loader.
export function tallyVotes(votes: readonly VoteRow[], userId: string | null): VoteTally {
  const tally: VoteTally = { ...EMPTY_TALLY };
  for (const vote of votes) {
    if (vote.kind === "karma") {
      tally.score += vote.value;
      if (userId && vote.userId === userId) tally.ownVote = vote.value;
    } else if (vote.kind === "agreement") {
      tally.agreement += vote.value;
      if (userId && vote.userId === userId) tally.ownAgreement = vote.value;
    }
  }
  return tally;
}

// Groups rows by target id and tallies each group (feeds load votes for many
// targets in one query).
export function tallyVotesByTarget<T extends VoteRow>(
  votes: readonly T[],
  targetOf: (vote: T) => string,
  userId: string | null
): Map<string, VoteTally> {
  const grouped = new Map<string, T[]>();
  for (const vote of votes) {
    const key = targetOf(vote);
    const list = grouped.get(key);
    if (list) list.push(vote);
    else grouped.set(key, [vote]);
  }
  const result = new Map<string, VoteTally>();
  for (const [key, rows] of grouped) result.set(key, tallyVotes(rows, userId));
  return result;
}

const VOTE_SELECT = { userId: true, kind: true, value: true } as const;

export async function documentVoteTally(documentId: string, userId: string | null): Promise<VoteTally> {
  const votes = await db.documentVote.findMany({ where: { documentId }, select: VOTE_SELECT });
  return tallyVotes(votes, userId);
}

export async function commentVoteTally(commentId: string, userId: string | null): Promise<VoteTally> {
  const votes = await db.commentVote.findMany({ where: { commentId }, select: VOTE_SELECT });
  return tallyVotes(votes, userId);
}

// Casts (±1, or ±STRONG_VOTE_WEIGHT on the karma axis) or clears (0) one
// user's vote of one kind and returns the fresh tally. Access has been checked
// by the caller; an out-of-range value throws.
export async function castDocumentVote(
  documentId: string,
  userId: string,
  kind: VoteKind,
  value: number
): Promise<VoteTally> {
  if (!isAllowedVoteValue(kind, value)) {
    throw new RangeError(`Invalid ${kind} vote value ${value}.`);
  }
  if (value === 0) {
    await db.documentVote.deleteMany({ where: { documentId, userId, kind } });
  } else {
    await db.documentVote.upsert({
      where: { documentId_userId_kind: { documentId, userId, kind } },
      create: { documentId, userId, kind, value },
      update: { value }
    });
  }
  return documentVoteTally(documentId, userId);
}

export async function castCommentVote(
  commentId: string,
  userId: string,
  kind: VoteKind,
  value: number
): Promise<VoteTally> {
  if (!isAllowedVoteValue(kind, value)) {
    throw new RangeError(`Invalid ${kind} vote value ${value}.`);
  }
  if (value === 0) {
    await db.commentVote.deleteMany({ where: { commentId, userId, kind } });
  } else {
    await db.commentVote.upsert({
      where: { commentId_userId_kind: { commentId, userId, kind } },
      create: { commentId, userId, kind, value },
      update: { value }
    });
  }
  return commentVoteTally(commentId, userId);
}
