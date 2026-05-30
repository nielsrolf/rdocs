import { db } from "@/lib/db";
import { extractMentionedUserIds, type MentionCandidate } from "@/lib/mentions";

/** Everyone who can be @mentioned in a document: its owner + members. */
export async function loadMentionCandidates(documentId: string): Promise<MentionCandidate[]> {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: {
      owner: { select: { id: true, name: true } },
      memberships: { select: { user: { select: { id: true, name: true } } } }
    }
  });
  if (!document) return [];
  const byId = new Map<string, MentionCandidate>();
  byId.set(document.owner.id, document.owner);
  for (const membership of document.memberships) {
    byId.set(membership.user.id, membership.user);
  }
  return [...byId.values()];
}

/**
 * Detect @mentions in a (just created or edited) comment body and record a
 * CommentMention for each mentioned member, skipping the author (no self-pings)
 * and any already-recorded mention (so editing doesn't reset acknowledgements).
 * Returns the user ids newly notified.
 */
export async function syncCommentMentions(input: {
  commentId: string;
  documentId: string;
  body: string;
  authorId: string | null;
}): Promise<string[]> {
  const candidates = await loadMentionCandidates(input.documentId);
  const mentionedIds = extractMentionedUserIds(input.body, candidates).filter(
    (id) => id !== input.authorId
  );
  const newlyNotified: string[] = [];
  for (const mentionedUserId of mentionedIds) {
    const result = await db.commentMention.upsert({
      where: { commentId_mentionedUserId: { commentId: input.commentId, mentionedUserId } },
      create: {
        commentId: input.commentId,
        documentId: input.documentId,
        mentionedUserId,
        acknowledged: false
      },
      update: {},
      select: { createdAt: true, acknowledged: true }
    });
    void result;
    newlyNotified.push(mentionedUserId);
  }
  return newlyNotified;
}

/** Per-document count of unacknowledged mentions for a user (dashboard badge). */
export async function getDocumentMentionStats(
  userId: string,
  documentIds: string[]
): Promise<Map<string, number>> {
  const byDoc = new Map<string, number>();
  if (documentIds.length === 0) return byDoc;
  const grouped = await db.commentMention.groupBy({
    by: ["documentId"],
    where: { mentionedUserId: userId, acknowledged: false, documentId: { in: documentIds } },
    _count: { _all: true }
  });
  for (const row of grouped) {
    byDoc.set(row.documentId, row._count._all);
  }
  return byDoc;
}

/** Mark all of a user's mentions in a document acknowledged (on viewing it). */
export async function acknowledgeDocumentMentions(userId: string, documentId: string): Promise<number> {
  const result = await db.commentMention.updateMany({
    where: { documentId, mentionedUserId: userId, acknowledged: false },
    data: { acknowledged: true }
  });
  return result.count;
}
