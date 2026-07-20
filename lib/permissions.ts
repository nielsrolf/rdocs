import { PermissionLevelValue } from "@/lib/contracts";
import { db } from "@/lib/db";
import type { AgentAccessMode } from "@/agent-core";

type AccessResult = {
  document: {
    id: string;
    title: string;
    kind: string;
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
      kind: true,
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

// A signed-in user who opens a doc through a valid share link becomes a
// persistent collaborator — the doc shows up on their dashboard exactly as if
// they had been invited by email. Idempotent; never downgrades an existing
// membership (resolveDocumentAccess only reports viaShareLink when the user
// has no membership, so the create path is the only one that normally runs).
export async function ensureShareLinkMembership(
  access: Pick<AccessResult, "viaShareLink" | "permission"> & {
    document: { id: string; ownerId: string };
  },
  userId: string | null | undefined
) {
  if (!userId || !access.viaShareLink || access.document.ownerId === userId) {
    return;
  }
  await db.documentMembership.upsert({
    where: {
      documentId_userId: {
        documentId: access.document.id,
        userId
      }
    },
    create: {
      documentId: access.document.id,
      userId,
      permission: access.permission
    },
    update: {}
  });
}

export function canComment(permission: PermissionLevelValue) {
  return permission === "COMMENT" || permission === "EDIT";
}

export function canEdit(permission: PermissionLevelValue) {
  return permission === "EDIT";
}

export function agentAccessModeForDocumentAccess(access: {
  permission: PermissionLevelValue;
  viaShareLink: boolean;
}): AgentAccessMode {
  return access.viaShareLink && !canEdit(access.permission) ? "read_only" : "workspace";
}

// Edit access is edit access: a signed-in user holding an edit link manages
// agent settings, environment, skills, and widgets just like a collaborator
// added by email. Only anonymous bearers are excluded — automation changes
// need an account behind them.
export function canManageDocumentAutomation(
  access: { permission: PermissionLevelValue; viaShareLink: boolean },
  userId: string | null | undefined
) {
  return Boolean(userId) && canEdit(access.permission);
}
