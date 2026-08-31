import { db } from "@/lib/db";
import { notifyForumItemShared } from "@/lib/activity-notifications";
import { defaultDocumentContent, serializeDocumentContent } from "@/lib/content";

// Quicktakes are short twitter-like forum posts. Each one is a Document row
// with kind "quicktake" (mirroring how Slack channels are a document kind):
// votes, nested comments, and group access all reuse the document machinery,
// while the studio dashboard and the main forum list filter the kind out.
//
// Visibility is a PER-USER setting (User.quicktakeGroupId), not per-take:
// null = public (forumPublic, readable logged-out), a group id = visible to
// that group's members only (a COMMENT-level DocumentGroupAccess grant, so
// members can also discuss). Changing the setting retroactively updates every
// existing quicktake of the user.

export const QUICKTAKE_KIND = "quicktake";
export const QUICKTAKE_MAX_LENGTH = 4000;

export type QuicktakeSummary = {
  id: string;
  body: string;
  createdAt: Date;
  owner: { id: string; name: string };
  isOwner: boolean;
  isPublic: boolean;
  groupName: string | null;
  score: number;
  ownVote: number;
  commentCount: number;
};

export type QuicktakeVisibility = {
  groupId: string | null;
  groupName: string | null;
};

function quicktakeTitle(body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text || "Quicktake";
}

// The group a user's quicktakes are restricted to, resolved only when the
// user actually belongs to it. A dangling/foreign id behaves like the group
// is gone: quicktakes stay non-public with no grants (owner-only), never
// silently public.
async function resolveVisibilityGroup(userId: string, groupId: string | null) {
  if (!groupId) return null;
  return db.group.findFirst({
    where: {
      id: groupId,
      OR: [{ ownerId: userId }, { members: { some: { userId } } }]
    },
    select: { id: true, name: true }
  });
}

export async function getQuicktakeVisibility(userId: string): Promise<QuicktakeVisibility> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { quicktakeGroupId: true }
  });
  const group = await resolveVisibilityGroup(userId, user?.quicktakeGroupId ?? null);
  return {
    groupId: user?.quicktakeGroupId ?? null,
    groupName: group?.name ?? null
  };
}

// Update the per-user visibility setting AND retroactively re-share every
// existing quicktake of the user ("quicktakes of one person all have the same
// sharing settings"). groupId null = public.
export async function setQuicktakeVisibility(
  userId: string,
  groupId: string | null
): Promise<QuicktakeVisibility> {
  if (groupId) {
    const group = await resolveVisibilityGroup(userId, groupId);
    if (!group) {
      throw new QuicktakeError("You are not a member of that group.");
    }
  }

  const takes = await db.document.findMany({
    where: { kind: QUICKTAKE_KIND, ownerId: userId },
    select: { id: true }
  });
  const takeIds = takes.map((t) => t.id);

  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { quicktakeGroupId: groupId } }),
    // Quicktakes are shared exclusively through this mechanism, so replacing
    // ALL group grants on them is safe.
    db.documentGroupAccess.deleteMany({ where: { documentId: { in: takeIds } } }),
    db.document.updateMany({
      where: { id: { in: takeIds } },
      data: { forumPublic: groupId === null }
    }),
    ...(groupId
      ? [
          db.documentGroupAccess.createMany({
            data: takeIds.map((documentId) => ({
              documentId,
              groupId,
              permission: "COMMENT"
            }))
          })
        ]
      : [])
  ]);

  return getQuicktakeVisibility(userId);
}

export class QuicktakeError extends Error {}

export async function createQuicktake(userId: string, body: string): Promise<QuicktakeSummary> {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new QuicktakeError("Quicktake body must not be empty.");
  }
  if (trimmed.length > QUICKTAKE_MAX_LENGTH) {
    throw new QuicktakeError("Quicktake body is too long.");
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, quicktakeGroupId: true }
  });
  if (!user) {
    throw new QuicktakeError("Unknown user.");
  }
  const group = await resolveVisibilityGroup(userId, user.quicktakeGroupId);

  const document = await db.document.create({
    data: {
      title: quicktakeTitle(trimmed),
      content: serializeDocumentContent(defaultDocumentContent),
      kind: QUICKTAKE_KIND,
      ownerId: userId,
      quicktakeBody: trimmed,
      forumPostedAt: new Date(),
      // Public unless the user restricted quicktakes to a group. A configured
      // but no-longer-resolvable group means owner-only, never public.
      forumPublic: user.quicktakeGroupId === null,
      ...(group
        ? {
            groupAccess: {
              create: { groupId: group.id, permission: "COMMENT" }
            }
          }
        : {})
    },
    select: { id: true, quicktakeBody: true, forumPostedAt: true }
  });

  if (group) {
    void notifyForumItemShared({ documentId: document.id, sharedByLabel: user.name });
  }

  return {
    id: document.id,
    body: document.quicktakeBody ?? trimmed,
    createdAt: document.forumPostedAt ?? new Date(),
    owner: { id: user.id, name: user.name },
    isOwner: true,
    isPublic: user.quicktakeGroupId === null,
    groupName: group?.name ?? null,
    score: 0,
    ownVote: 0,
    commentCount: 0
  };
}

export async function deleteQuicktake(userId: string, quicktakeId: string): Promise<boolean> {
  const deleted = await db.document.deleteMany({
    where: { id: quicktakeId, kind: QUICKTAKE_KIND, ownerId: userId }
  });
  return deleted.count > 0;
}

// Every quicktake the viewer may read, newest first: their own, public ones,
// and ones shared with a group they belong to. userId null = logged-out
// visitor (public only).
export async function listQuicktakes(
  userId: string | null,
  limit = 100
): Promise<QuicktakeSummary[]> {
  const takes = await db.document.findMany({
    where: {
      kind: QUICKTAKE_KIND,
      forumPostedAt: { not: null },
      OR: [
        { forumPublic: true },
        ...(userId
          ? [
              { ownerId: userId },
              { groupAccess: { some: { group: { members: { some: { userId } } } } } },
              { groupAccess: { some: { group: { ownerId: userId } } } }
            ]
          : [])
      ]
    },
    orderBy: { forumPostedAt: "desc" },
    take: limit,
    select: {
      id: true,
      quicktakeBody: true,
      forumPostedAt: true,
      forumPublic: true,
      ownerId: true,
      owner: { select: { id: true, name: true } },
      groupAccess: { select: { group: { select: { name: true } } }, take: 1 }
    }
  });
  if (takes.length === 0) return [];
  const takeIds = takes.map((t) => t.id);

  const [votes, threads] = await Promise.all([
    db.documentVote.findMany({
      where: { documentId: { in: takeIds } },
      select: { documentId: true, userId: true, value: true }
    }),
    db.commentThread.findMany({
      where: { documentId: { in: takeIds }, status: "OPEN" },
      select: { documentId: true, _count: { select: { comments: true } } }
    })
  ]);

  const scoreByDoc = new Map<string, number>();
  const ownVoteByDoc = new Map<string, number>();
  for (const vote of votes) {
    scoreByDoc.set(vote.documentId, (scoreByDoc.get(vote.documentId) ?? 0) + vote.value);
    if (vote.userId === userId) ownVoteByDoc.set(vote.documentId, vote.value);
  }
  const commentsByDoc = new Map<string, number>();
  for (const thread of threads) {
    commentsByDoc.set(
      thread.documentId,
      (commentsByDoc.get(thread.documentId) ?? 0) + thread._count.comments
    );
  }

  return takes.map((take) => ({
    id: take.id,
    body: take.quicktakeBody ?? "",
    createdAt: take.forumPostedAt as Date,
    owner: take.owner,
    isOwner: take.ownerId === userId,
    isPublic: take.forumPublic,
    groupName: take.groupAccess[0]?.group.name ?? null,
    score: scoreByDoc.get(take.id) ?? 0,
    ownVote: ownVoteByDoc.get(take.id) ?? 0,
    commentCount: commentsByDoc.get(take.id) ?? 0
  }));
}

// A single quicktake, permission-checked by the caller (resolveDocumentAccess)
// — this only shapes the summary.
export async function getQuicktake(
  quicktakeId: string,
  userId: string | null
): Promise<QuicktakeSummary | null> {
  const take = await db.document.findUnique({
    where: { id: quicktakeId },
    select: {
      id: true,
      kind: true,
      quicktakeBody: true,
      forumPostedAt: true,
      forumPublic: true,
      ownerId: true,
      owner: { select: { id: true, name: true } },
      groupAccess: { select: { group: { select: { name: true } } }, take: 1 }
    }
  });
  if (!take || take.kind !== QUICKTAKE_KIND) return null;

  const [voteAgg, ownVote, commentCount] = await Promise.all([
    db.documentVote.aggregate({ where: { documentId: quicktakeId }, _sum: { value: true } }),
    userId
      ? db.documentVote.findUnique({
          where: { documentId_userId: { documentId: quicktakeId, userId } },
          select: { value: true }
        })
      : Promise.resolve(null),
    db.comment.count({ where: { thread: { documentId: quicktakeId } } })
  ]);

  return {
    id: take.id,
    body: take.quicktakeBody ?? "",
    createdAt: take.forumPostedAt ?? new Date(),
    owner: take.owner,
    isOwner: take.ownerId === userId,
    isPublic: take.forumPublic,
    groupName: take.groupAccess[0]?.group.name ?? null,
    score: voteAgg._sum.value ?? 0,
    ownVote: ownVote?.value ?? 0,
    commentCount
  };
}
