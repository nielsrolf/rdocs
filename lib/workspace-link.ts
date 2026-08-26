import { copyAttachmentBetweenStores } from "@/lib/attachments";
import { getDocumentPlainText, parseDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";

// Workspace links (Document.workspaceDocumentId) let a regular doc join the
// workspace owned by a Slack-backed document. A Slack channel can also be
// rebound to a regular doc: in that direction we merge the temporary
// slack_channel row into the regular doc, which becomes the channel's backing
// document and therefore supplies its content, settings, env and agent history.
// Legacy slack_channel -> document workspace links remain readable.

export type WorkspaceLinkTarget = {
  id: string;
  title: string;
  slackChannelId: string | null;
};

export type SlackChannelBindingResult =
  | { action: "merged"; target: WorkspaceLinkTarget }
  | { action: "moved"; target: WorkspaceLinkTarget }
  | { action: "unbound" }
  | { action: "link-cleared" }
  | { action: "unchanged"; target: WorkspaceLinkTarget };

export class WorkspaceLinkError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// Slack-backed documents the user can already act in. New channel documents
// have kind=slack_channel; after a channel->doc merge, the regular document
// itself carries the Slack ids and remains a valid workspace-link target.
export async function listConnectableSlackChannelDocuments(
  userId: string
): Promise<WorkspaceLinkTarget[]> {
  return db.document.findMany({
    where: {
      AND: [
        {
          OR: [
            { kind: "slack_channel" },
            {
              kind: "document",
              slackTeamId: { not: null },
              slackChannelId: { not: null }
            }
          ]
        },
        { OR: [{ ownerId: userId }, { memberships: { some: { userId } } }] }
      ]
    },
    select: { id: true, title: true, slackChannelId: true },
    orderBy: { updatedAt: "desc" }
  });
}

export async function getWorkspaceLink(documentId: string): Promise<WorkspaceLinkTarget | null> {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: { workspaceDocumentId: true }
  });
  if (!document?.workspaceDocumentId) {
    return null;
  }
  return db.document.findUnique({
    where: { id: document.workspaceDocumentId },
    select: { id: true, title: true, slackChannelId: true }
  });
}

// Legacy compatibility: before channel->doc merges were introduced, a
// slack_channel row could point at a regular doc. Such channels still include
// that doc's content until the binding is set again and the rows are merged.
export type LinkedWorkspaceDocContext = { id: string; title: string; text: string };

export async function getLinkedWorkspaceDocContext(
  documentId: string
): Promise<LinkedWorkspaceDocContext | null> {
  const source = await db.document.findUnique({
    where: { id: documentId },
    select: { kind: true, workspaceDocumentId: true }
  });
  if (source?.kind !== "slack_channel" || !source.workspaceDocumentId) {
    return null;
  }
  const target = await db.document.findUnique({
    where: { id: source.workspaceDocumentId },
    select: { id: true, title: true, kind: true, content: true }
  });
  if (!target || target.kind !== "document") {
    return null;
  }
  const text = getDocumentPlainText(parseDocumentContent(target.content));
  return { id: target.id, title: target.title, text };
}

function workspaceLinkTarget(document: {
  id: string;
  title: string;
  slackChannelId: string | null;
}): WorkspaceLinkTarget {
  return {
    id: document.id,
    title: document.title,
    slackChannelId: document.slackChannelId
  };
}

// Rebind the Slack channel represented by documentId. A temporary
// slack_channel source is merged into the target and deleted. If the source is
// already a merged regular doc, only the channel binding (and channel-scoped
// schedules) moves; the old doc and its history stay intact.
//
// The caller is responsible for access to the source channel. This function
// requires EDIT access to a target because future channel runs will use the
// target's settings and read/write its workspace.
export async function setSlackChannelDocument(input: {
  documentId: string;
  targetDocumentId: string | null;
  userId: string;
}): Promise<SlackChannelBindingResult> {
  const source = await db.document.findUnique({
    where: { id: input.documentId },
    select: {
      id: true,
      title: true,
      kind: true,
      ownerId: true,
      slackTeamId: true,
      slackChannelId: true,
      workspaceDocumentId: true,
      memberships: { select: { userId: true } },
      attachments: { select: { id: true, storedName: true } }
    }
  });
  if (!source) {
    throw new WorkspaceLinkError("Document not found.", 404);
  }
  if (
    (source.kind !== "slack_channel" && source.kind !== "document") ||
    !source.slackTeamId ||
    !source.slackChannelId
  ) {
    throw new WorkspaceLinkError("This document is not backed by a Slack channel.");
  }

  if (input.targetDocumentId === null) {
    if (source.kind === "slack_channel") {
      await db.document.update({
        where: { id: source.id },
        data: { workspaceDocumentId: null }
      });
      return { action: "link-cleared" };
    }
    await db.document.update({
      where: { id: source.id },
      data: { slackTeamId: null, slackChannelId: null }
    });
    return { action: "unbound" };
  }

  if (input.targetDocumentId === source.id) {
    if (source.kind === "document") {
      return { action: "unchanged", target: workspaceLinkTarget(source) };
    }
    throw new WorkspaceLinkError("A Slack channel document cannot merge into itself.");
  }

  const target = await db.document.findUnique({
    where: { id: input.targetDocumentId },
    select: {
      id: true,
      title: true,
      kind: true,
      slackTeamId: true,
      slackChannelId: true,
      workspaceDocumentId: true
    }
  });
  if (!target || target.kind !== "document") {
    throw new WorkspaceLinkError(
      "A Slack channel can only be connected to a regular document.",
      404
    );
  }
  if (target.slackTeamId || target.slackChannelId) {
    throw new WorkspaceLinkError("That document already backs another Slack channel.");
  }
  if (target.workspaceDocumentId && target.workspaceDocumentId !== source.id) {
    throw new WorkspaceLinkError(
      "That document already shares another workspace; connect a document that owns its workspace."
    );
  }

  const targetAccess = await resolveDocumentAccess(target.id, input.userId, null);
  if (!targetAccess || !canEdit(targetAccess.permission)) {
    throw new WorkspaceLinkError(
      "You need edit access to that document to connect this Slack channel.",
      403
    );
  }

  if (source.kind === "slack_channel") {
    // File I/O cannot be part of the Prisma transaction. Copy first, then move
    // each row to the exact collision-safe name. On DB failure, extra copied
    // files are harmless; the source rows and files remain authoritative.
    const copiedAttachments = await Promise.all(
      source.attachments.map(async (attachment) => ({
        id: attachment.id,
        storedName: await copyAttachmentBetweenStores(source.id, target.id, attachment.storedName)
      }))
    );
    const memberIds = new Set(source.memberships.map((membership) => membership.userId));
    memberIds.add(source.ownerId);

    await db.$transaction(async (tx) => {
      // Preserve the channel's run history (including the currently executing
      // set_channel_workspace run) and its scheduled tasks before deleting the
      // temporary document, whose relations otherwise cascade.
      await tx.aiRun.updateMany({
        where: { documentId: source.id },
        data: { documentId: target.id }
      });
      await tx.scheduledTask.updateMany({
        where: { documentId: source.id },
        data: { documentId: target.id }
      });
      for (const attachment of copiedAttachments) {
        await tx.attachment.update({
          where: { id: attachment.id },
          data: { documentId: target.id, storedName: attachment.storedName }
        });
      }
      for (const userId of memberIds) {
        await tx.documentMembership.upsert({
          where: { documentId_userId: { documentId: target.id, userId } },
          create: { documentId: target.id, userId, permission: "EDIT" },
          update: { permission: "EDIT" }
        });
      }
      await tx.document.updateMany({
        where: {
          workspaceDocumentId: source.id,
          id: { not: target.id }
        },
        data: { workspaceDocumentId: target.id }
      });
      // Delete first to release @@unique([slackTeamId, slackChannelId]), then
      // put those ids directly on the canonical document.
      await tx.document.delete({ where: { id: source.id } });
      await tx.document.update({
        where: { id: target.id },
        data: {
          slackTeamId: source.slackTeamId,
          slackChannelId: source.slackChannelId,
          workspaceDocumentId: null
        }
      });
    });

    return {
      action: "merged",
      target: { id: target.id, title: target.title, slackChannelId: source.slackChannelId }
    };
  }

  // The source is already a canonical regular doc. Keep its history and files,
  // but transfer the Slack identity and channel-scoped schedules to the target.
  await db.$transaction(async (tx) => {
    await tx.document.update({
      where: { id: source.id },
      data: { slackTeamId: null, slackChannelId: null }
    });
    await tx.document.update({
      where: { id: target.id },
      data: {
        slackTeamId: source.slackTeamId,
        slackChannelId: source.slackChannelId,
        workspaceDocumentId: null
      }
    });
    await tx.scheduledTask.updateMany({
      where: {
        // Guarded as non-null above; capture the narrowing for Prisma's
        // non-null ScheduledTask fields.
        slackTeamId: source.slackTeamId!,
        slackChannelId: source.slackChannelId!
      },
      data: { documentId: target.id }
    });
  });

  return {
    action: "moved",
    target: { id: target.id, title: target.title, slackChannelId: source.slackChannelId }
  };
}

// Set (or clear) a regular workspace link. In the channel->doc direction this
// now delegates to setSlackChannelDocument, so API/UI callers get the same
// merge semantics as the Slack tool.
export async function setWorkspaceLink(input: {
  documentId: string;
  targetDocumentId: string | null;
  userId: string;
}): Promise<WorkspaceLinkTarget | null> {
  const source = await db.document.findUnique({
    where: { id: input.documentId },
    select: { id: true, kind: true }
  });
  if (!source) {
    throw new WorkspaceLinkError("Document not found.", 404);
  }
  if (source.kind !== "slack_channel" && source.kind !== "document") {
    throw new WorkspaceLinkError("This document type cannot link a workspace.");
  }

  if (input.targetDocumentId === null) {
    await db.document.update({
      where: { id: input.documentId },
      data: { workspaceDocumentId: null }
    });
    return null;
  }

  if (input.targetDocumentId === input.documentId) {
    throw new WorkspaceLinkError("A document cannot link its own workspace.");
  }

  if (source.kind === "slack_channel") {
    const result = await setSlackChannelDocument(input);
    return "target" in result ? result.target : null;
  }

  const target = await db.document.findUnique({
    where: { id: input.targetDocumentId },
    select: { id: true, title: true, kind: true, slackChannelId: true, workspaceDocumentId: true }
  });
  const targetIsSlackBacked =
    target &&
    (target.kind === "slack_channel" ||
      (target.kind === "document" && target.slackChannelId !== null));
  if (!targetIsSlackBacked) {
    throw new WorkspaceLinkError("Workspace links must point at a Slack-backed document.", 404);
  }
  if (target.workspaceDocumentId === input.documentId) {
    throw new WorkspaceLinkError(
      "That Slack channel already shares this document's workspace; linking back would create a cycle."
    );
  }

  const targetAccess = await resolveDocumentAccess(target.id, input.userId, null);
  if (!targetAccess || !canEdit(targetAccess.permission)) {
    throw new WorkspaceLinkError(
      "You need edit access to that document to connect its workspace.",
      403
    );
  }

  await db.document.update({
    where: { id: input.documentId },
    data: {
      workspaceDocumentId: target.id,
      repoUrl: null,
      repoBranch: null,
      repoWorkspace: null
    }
  });

  return workspaceLinkTarget(target);
}
