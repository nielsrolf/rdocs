import { db } from "@/lib/db";
import { extractMentionedUserIds, type MentionCandidate } from "@/lib/mentions";

/** Everyone who can be @mentioned in a document: its owner + members. */
export async function loadMentionCandidates(documentId: string): Promise<MentionCandidate[]> {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: {
      owner: { select: { id: true, name: true, email: true } },
      memberships: { select: { user: { select: { id: true, name: true, email: true } } } }
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

/**
 * Comment ids in a document that @mention `userId` and haven't been seen yet.
 * Used to deep-link + highlight the mentioning comment when the user opens the
 * doc from their dashboard notification. Read before acknowledging.
 */
export async function listUnacknowledgedMentionCommentIds(
  userId: string,
  documentId: string
): Promise<string[]> {
  const rows = await db.commentMention.findMany({
    where: { documentId, mentionedUserId: userId, acknowledged: false },
    select: { commentId: true }
  });
  return [...new Set(rows.map((row) => row.commentId))];
}

/**
 * Record that `mentionedUserId` was @mentioned in the BODY of `documentId`
 * (via the editor autocomplete). Skips self-mentions and non-members. Upserts
 * so repeat mentions re-surface as unacknowledged rather than piling up.
 * Returns true if a (new or refreshed) notification was recorded.
 */
export async function recordDocumentMention(input: {
  documentId: string;
  mentionedUserId: string;
  authorId: string | null;
}): Promise<boolean> {
  if (!input.mentionedUserId || input.mentionedUserId === input.authorId) return false;
  const candidates = await loadMentionCandidates(input.documentId);
  if (!candidates.some((candidate) => candidate.id === input.mentionedUserId)) return false;
  await db.documentMention.upsert({
    where: {
      documentId_mentionedUserId: {
        documentId: input.documentId,
        mentionedUserId: input.mentionedUserId
      }
    },
    create: {
      documentId: input.documentId,
      mentionedUserId: input.mentionedUserId,
      acknowledged: false
    },
    update: { acknowledged: false }
  });
  return true;
}

/** Per-document count of unacknowledged mentions (comment + doc body) for a user. */
export async function getDocumentMentionStats(
  userId: string,
  documentIds: string[]
): Promise<Map<string, number>> {
  const byDoc = new Map<string, number>();
  if (documentIds.length === 0) return byDoc;
  const [commentGroups, docGroups] = await Promise.all([
    db.commentMention.groupBy({
      by: ["documentId"],
      where: { mentionedUserId: userId, acknowledged: false, documentId: { in: documentIds } },
      _count: { _all: true }
    }),
    db.documentMention.groupBy({
      by: ["documentId"],
      where: { mentionedUserId: userId, acknowledged: false, documentId: { in: documentIds } },
      _count: { _all: true }
    })
  ]);
  for (const row of [...commentGroups, ...docGroups]) {
    byDoc.set(row.documentId, (byDoc.get(row.documentId) ?? 0) + row._count._all);
  }
  return byDoc;
}

/** Mark all of a user's mentions (comment + doc body) in a document acknowledged. */
export async function acknowledgeDocumentMentions(userId: string, documentId: string): Promise<number> {
  const [comments, docs] = await Promise.all([
    db.commentMention.updateMany({
      where: { documentId, mentionedUserId: userId, acknowledged: false },
      data: { acknowledged: true }
    }),
    db.documentMention.updateMany({
      where: { documentId, mentionedUserId: userId, acknowledged: false },
      data: { acknowledged: true }
    })
  ]);
  return comments.count + docs.count;
}
