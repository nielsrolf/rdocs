import { PermissionLevelValue } from "@/lib/contracts";
import { db } from "@/lib/db";

type AccessResult = {
  document: {
    id: string;
    title: string;
    content: string;
    ownerId: string;
    repoUrl: string | null;
    repoBranch: string | null;
    repoWorkspace: string | null;
    activeAiRunId: string | null;
    agentModel: string | null;
    agentEffort: string | null;
    updatedAt: Date;
  };
  permission: PermissionLevelValue;
  viaShareLink: boolean;
  shareToken: string | null;
};

export async function resolveDocumentAccess(
  documentId: string,
  userId?: string | null,
  shareToken?: string | null
): Promise<AccessResult | null> {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      title: true,
      content: true,
      ownerId: true,
      repoUrl: true,
      repoBranch: true,
      repoWorkspace: true,
      activeAiRunId: true,
      agentModel: true,
      agentEffort: true,
      updatedAt: true
    }
  });

  if (!document) {
    return null;
  }

  if (userId && document.ownerId === userId) {
    return {
      document,
      permission: "EDIT",
      viaShareLink: false,
      shareToken: null
    };
  }

  if (userId) {
    const membership = await db.documentMembership.findUnique({
      where: {
        documentId_userId: {
          documentId,
          userId
        }
      },
      select: {
        permission: true
      }
    });

    if (membership) {
      return {
        document,
        permission: membership.permission as PermissionLevelValue,
        viaShareLink: false,
        shareToken: null
      };
    }
  }

  if (shareToken) {
    const link = await db.shareLink.findFirst({
      where: {
        documentId,
        token: shareToken,
        revokedAt: null
      },
      select: {
        permission: true,
        token: true
      }
    });

    if (link) {
      return {
        document,
        permission: link.permission as PermissionLevelValue,
        viaShareLink: true,
        shareToken: link.token
      };
    }
  }

  return null;
}

export function canComment(permission: PermissionLevelValue) {
  return permission === "COMMENT" || permission === "EDIT";
}

export function canEdit(permission: PermissionLevelValue) {
  return permission === "EDIT";
}
