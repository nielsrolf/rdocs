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
    runnerMode: string;
    forumPostedAt: Date | null;
    forumPublic: boolean;
    updatedAt: Date;
  };
  permission: PermissionLevelValue;
  viaShareLink: boolean;
  // True when the ONLY reason the viewer can see this document is that it is
  // a public forum post (forumPostedAt + forumPublic). Read-only public
  // rendering; never persisted as a membership.
  viaForumPublic: boolean;
  shareToken: string | null;
};

const PERMISSION_RANK: Record<PermissionLevelValue, number> = {
  VIEW: 1,
  COMMENT: 2,
  EDIT: 3
};

export function strongestPermission(
  permissions: PermissionLevelValue[]
): PermissionLevelValue | null {
  let best: PermissionLevelValue | null = null;
  for (const permission of permissions) {
    if (!PERMISSION_RANK[permission]) continue;
    if (!best || PERMISSION_RANK[permission] > PERMISSION_RANK[best]) {
      best = permission;
    }
  }
  return best;
}

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
      runnerMode: true,
      forumPostedAt: true,
      forumPublic: true,
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
      viaForumPublic: false,
      shareToken: null
    };
  }

  if (userId) {
    const [membership, groupGrants] = await Promise.all([
      db.documentMembership.findUnique({
        where: {
          documentId_userId: {
            documentId,
            userId
          }
        },
        select: {
          permission: true
        }
      }),
      db.documentGroupAccess.findMany({
        where: {
          documentId,
          group: { members: { some: { userId } } }
        },
        select: { permission: true }
      })
    ]);

    // Effective permission is the STRONGEST across the direct membership and
    // every group the user belongs to that was granted access.
    const candidates = [
      ...(membership ? [membership.permission] : []),
      ...groupGrants.map((grant) => grant.permission)
    ] as PermissionLevelValue[];
    const permission = strongestPermission(candidates);

    if (permission) {
      return {
        document,
        permission,
        viaShareLink: false,
        viaForumPublic: false,
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
        viaForumPublic: false,
        shareToken: link.token
      };
    }
  }

  // Public forum posts are readable by everyone — including logged-out
  // visitors. VIEW only; commenting/voting still require an account (their
  // routes check sign-in separately).
  if (document.forumPostedAt && document.forumPublic) {
    return {
      document,
      permission: "VIEW",
      viaShareLink: false,
      viaForumPublic: true,
      shareToken: null
    };
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

// Forum-public documents (public posts and quicktakes) accept comments from
// ANY signed-in user — that's the point of posting publicly — while
// logged-out visitors stay read-only. Everything else keeps the normal
// COMMENT/EDIT gate.
export function canCommentOnDocument(
  access: Pick<AccessResult, "permission" | "viaForumPublic">,
  isSignedIn: boolean
) {
  return canComment(access.permission) || (isSignedIn && access.viaForumPublic);
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
