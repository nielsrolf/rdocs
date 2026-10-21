// Server-side reaction writes, shared by the comment-reaction toggle route and
// the text-reaction create path of POST /api/documents/:id/comments. Access
// checks stay in the routes; these functions assume the caller may react.

import { db } from "@/lib/db";
import { REACTION_THREAD_ORIGIN, reactionThreadBody, type RawReaction } from "@/lib/reactions";

const RAW_REACTION_SELECT = { emoji: true, userId: true, user: { select: { name: true } } } as const;

export const REACTION_THREAD_SELECT = {
  id: true,
  origin: true,
  anchorText: true,
  anchorContext: true,
  status: true,
  tags: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
  comments: {
    orderBy: { createdAt: "asc" },
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
      author: { select: { id: true, name: true } },
      reactions: { select: RAW_REACTION_SELECT }
    }
  }
} as const;

/**
 * Create a text reaction: a thread anchored to the selection (the caller has
 * already verified the commentAnchor mark is persisted) whose root comment
 * carries the user's first reaction.
 */
export async function createReactionThread(input: {
  threadId?: string;
  documentId: string;
  userId: string;
  emoji: string;
  anchorText: string;
  anchorContext?: string | null;
}) {
  return db.commentThread.create({
    data: {
      id: input.threadId,
      documentId: input.documentId,
      createdById: input.userId,
      origin: REACTION_THREAD_ORIGIN,
      anchorText: input.anchorText,
      anchorContext: input.anchorContext ?? null,
      comments: {
        create: {
          body: input.emoji,
          authorId: input.userId,
          reactions: { create: { userId: input.userId, emoji: input.emoji } }
        }
      }
    },
    select: REACTION_THREAD_SELECT
  });
}

/**
 * Toggle one user's emoji on a comment. On a text-reaction thread the root
 * comment's body follows the remaining emoji, and removing the last reaction
 * deletes the whole thread (an empty reaction has nothing left to show).
 */
export async function toggleCommentReaction(input: {
  commentId: string;
  threadId: string;
  threadOrigin: string;
  userId: string;
  emoji: string;
}): Promise<{ rows: RawReaction[]; deletedThreadId: string | null }> {
  const { commentId, userId, emoji } = input;
  const existing = await db.commentReaction.findUnique({
    where: { commentId_userId_emoji: { commentId, userId, emoji } },
    select: { id: true }
  });
  if (existing) {
    await db.commentReaction.delete({ where: { id: existing.id } });
  } else {
    await db.commentReaction.create({ data: { commentId, userId, emoji } });
  }

  const rows: RawReaction[] = await db.commentReaction.findMany({
    where: { commentId },
    orderBy: { createdAt: "asc" },
    select: RAW_REACTION_SELECT
  });

  if (input.threadOrigin === REACTION_THREAD_ORIGIN) {
    if (rows.length === 0) {
      await db.commentThread.delete({ where: { id: input.threadId } });
      return { rows, deletedThreadId: input.threadId };
    }
    await db.comment.update({ where: { id: commentId }, data: { body: reactionThreadBody(rows) } });
  }

  return { rows, deletedThreadId: null };
}
