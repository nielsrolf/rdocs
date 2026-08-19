import { db } from "@/lib/db";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";

// Linking a document to a Slack channel workspace (Document.workspaceDocumentId):
// the doc keeps its own content/comments/settings, but every agent run checks
// out worktrees from — and merges results back into — the channel document's
// base workspace instead of having one of its own. See
// resolveWorkspaceDocumentId in lib/research-workspace.ts for run-time
// resolution. Mutually exclusive with a linked git repo.

export type WorkspaceLinkTarget = {
  id: string;
  title: string;
  slackChannelId: string | null;
};

export class WorkspaceLinkError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// Slack-channel documents the user can already act in: owned or joined
// (membership rows are added when the user triggers the bot in the channel or
// is added as a collaborator). These are the only valid link targets.
export async function listConnectableSlackChannelDocuments(
  userId: string
): Promise<WorkspaceLinkTarget[]> {
  return db.document.findMany({
    where: {
      kind: "slack_channel",
      OR: [{ ownerId: userId }, { memberships: { some: { userId } } }]
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

// Set (or clear, with targetDocumentId=null) the workspace link. The caller
// is responsible for edit access on the SOURCE document; this function
// enforces everything about the TARGET: it must be a slack_channel document
// the linking user can EDIT — linking grants every agent run on the source
// doc read/write access to the channel workspace, so read access is not
// enough.
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
  if (source.kind === "slack_channel") {
    // Channel documents ARE workspaces; letting them point elsewhere would
    // make resolution ambiguous (resolution is deliberately one level deep).
    throw new WorkspaceLinkError("A Slack channel document cannot link another workspace.");
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

  const target = await db.document.findUnique({
    where: { id: input.targetDocumentId },
    select: { id: true, title: true, kind: true, slackChannelId: true }
  });
  if (!target || target.kind !== "slack_channel") {
    throw new WorkspaceLinkError("Workspace links must point at a Slack channel document.", 404);
  }

  const targetAccess = await resolveDocumentAccess(target.id, input.userId, null);
  if (!targetAccess || !canEdit(targetAccess.permission)) {
    throw new WorkspaceLinkError(
      "You need edit access to that Slack channel's document to connect its workspace.",
      403
    );
  }

  await db.document.update({
    where: { id: input.documentId },
    data: {
      workspaceDocumentId: target.id,
      // Mutually exclusive with a linked repo: the workspace now comes from
      // the channel document (which may itself have a repo linked).
      repoUrl: null,
      repoBranch: null,
      repoWorkspace: null
    }
  });

  return { id: target.id, title: target.title, slackChannelId: target.slackChannelId };
}
