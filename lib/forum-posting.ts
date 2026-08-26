import { db } from "@/lib/db";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";

export type ForumPostAudience =
  | { type: "existing" }
  | { type: "public" }
  | { type: "group"; groupId: string };

export class ForumPostingError extends Error {
  constructor(
    message: string,
    readonly code: "document-not-found" | "not-editable" | "invalid-document" | "group-not-found"
  ) {
    super(message);
    this.name = "ForumPostingError";
  }
}

export async function listForumPostCandidates(userId: string) {
  return db.document.findMany({
    where: {
      kind: "document",
      forumPostedAt: null,
      OR: [
        { ownerId: userId },
        { memberships: { some: { userId, permission: "EDIT" } } },
        {
          groupAccess: {
            some: { permission: "EDIT", group: { members: { some: { userId } } } }
          }
        }
      ]
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, updatedAt: true }
  });
}

export async function publishForumPost(input: {
  documentId: string;
  userId: string;
  audience: ForumPostAudience;
}) {
  const access = await resolveDocumentAccess(input.documentId, input.userId);
  if (!access) {
    throw new ForumPostingError("Document not found.", "document-not-found");
  }
  if (!canEdit(access.permission)) {
    throw new ForumPostingError("You do not have edit access.", "not-editable");
  }
  if (access.document.kind !== "document") {
    throw new ForumPostingError("Only regular documents can be posted here.", "invalid-document");
  }

  let group:
    | { id: string; ownerId: string; members: { userId: string }[] }
    | null = null;
  if (input.audience.type === "group") {
    group = await db.group.findFirst({
      where: {
        id: input.audience.groupId,
        OR: [{ ownerId: input.userId }, { members: { some: { userId: input.userId } } }]
      },
      select: { id: true, ownerId: true, members: { select: { userId: true } } }
    });
    if (!group) {
      throw new ForumPostingError("Group not found.", "group-not-found");
    }
  }

  const existingGrant = group
    ? await db.documentGroupAccess.findUnique({
        where: { documentId_groupId: { documentId: input.documentId, groupId: group.id } },
        select: { id: true }
      })
    : null;
  const forumPostedAt = access.document.forumPostedAt ?? new Date();

  await db.$transaction(async (tx) => {
    if (group) {
      await tx.documentGroupAccess.upsert({
        where: { documentId_groupId: { documentId: input.documentId, groupId: group.id } },
        create: {
          documentId: input.documentId,
          groupId: group.id,
          permission: "VIEW"
        },
        update: {}
      });
    }
    await tx.document.update({
      where: { id: input.documentId },
      data: {
        forumPostedAt,
        forumPublic: input.audience.type === "public"
      }
    });
  });

  const newlySharedUserIds =
    group && !existingGrant
      ? [...new Set([group.ownerId, ...group.members.map((member) => member.userId)])].filter(
          (userId) => userId !== input.userId
        )
      : [];

  return {
    forumPostedAt,
    forumPublic: input.audience.type === "public",
    newlySharedUserIds
  };
}
