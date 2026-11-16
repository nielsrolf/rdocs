import type { Prisma } from "@prisma/client";

import { parseDocumentContent, serializeDocumentContent, stripCommentAnchorMarks } from "@/lib/content";
import { db } from "@/lib/db";
import { copyOwnerDefaultSkillsToDocument } from "@/lib/document-skills";
import { copySkillDir, getDocumentSkillDir } from "@/lib/skills";

// Templates. A template is an ordinary document with `isTemplate` set (by its
// owner, File menu). Whether it shows up under "New document" is PER USER: a
// `UserTemplate` row says "added" or "dismissed", and no row means the user
// was never asked — the app then offers it (dashboard + inside the document).
// Whoever marks a document as a template gets it added right away.
//
// A template is only ever usable or listed while the user can still open the
// document: every query goes through `accessibleTemplateWhere`, so revoking
// access (or unmarking the document) silently takes it out of every list.

export type TemplateStatus = "added" | "dismissed";

export type TemplateListing = {
  id: string;
  title: string;
  ownerName: string;
  isOwner: boolean;
  // null = shared with the user but not decided yet (an open offer).
  status: TemplateStatus | null;
};

export class TemplateError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

function accessibleTemplateWhere(userId: string): Prisma.DocumentWhereInput {
  return {
    isTemplate: true,
    kind: "document",
    OR: [
      { ownerId: userId },
      { memberships: { some: { userId } } },
      { groupAccess: { some: { group: { members: { some: { userId } } } } } }
    ]
  };
}

function normalizeStatus(value: string | null | undefined): TemplateStatus | null {
  return value === "added" || value === "dismissed" ? value : null;
}

// Every template the user can open, with their decision about it. Added ones
// first, then open offers, then dismissed; alphabetical within each.
export async function listTemplatesForUser(userId: string): Promise<TemplateListing[]> {
  const rows = await db.document.findMany({
    where: accessibleTemplateWhere(userId),
    select: {
      id: true,
      title: true,
      ownerId: true,
      owner: { select: { name: true } },
      templateUsers: { where: { userId }, select: { status: true } }
    }
  });
  const rank = (status: TemplateStatus | null) => (status === "added" ? 0 : status === null ? 1 : 2);
  return rows
    .map((row) => ({
      id: row.id,
      title: row.title,
      ownerName: row.owner.name,
      isOwner: row.ownerId === userId,
      status: normalizeStatus(row.templateUsers[0]?.status)
    }))
    .sort((a, b) => rank(a.status) - rank(b.status) || a.title.localeCompare(b.title));
}

// The "New document" options.
export async function listAddedTemplates(userId: string): Promise<TemplateListing[]> {
  return (await listTemplatesForUser(userId)).filter((template) => template.status === "added");
}

// Templates someone shared with the user that they have not decided about.
export async function listTemplateOffers(userId: string): Promise<TemplateListing[]> {
  return (await listTemplatesForUser(userId)).filter(
    (template) => template.status === null && !template.isOwner
  );
}

// What the document page needs: is this a template, and what did this viewer
// decide. `offer` is true when the viewer should be asked.
export async function getTemplateStateForViewer(documentId: string, userId: string | null) {
  const row = await db.document.findUnique({
    where: { id: documentId },
    select: {
      isTemplate: true,
      ownerId: true,
      templateUsers: userId ? { where: { userId }, select: { status: true } } : false
    }
  });
  const isTemplate = Boolean(row?.isTemplate);
  const status = normalizeStatus(row?.templateUsers?.[0]?.status);
  return {
    isTemplate,
    status,
    offer: Boolean(isTemplate && userId && row?.ownerId !== userId && status === null)
  };
}

// Owner-only (the caller checks ownership). Marking adds the template to the
// owner's own list; unmarking keeps everyone's rows, so re-marking restores
// the lists as they were.
export async function setDocumentTemplate(documentId: string, userId: string, isTemplate: boolean) {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: { ownerId: true, kind: true }
  });
  if (!document) throw new TemplateError("Document not found.", 404);
  if (document.ownerId !== userId) {
    throw new TemplateError("Only the owner can make a document a template.", 403);
  }
  if (document.kind !== "document") {
    throw new TemplateError("Only regular documents can be templates.", 400);
  }
  await db.document.update({ where: { id: documentId }, data: { isTemplate } });
  if (isTemplate) {
    await db.userTemplate.upsert({
      where: { userId_documentId: { userId, documentId } },
      create: { userId, documentId, status: "added" },
      update: { status: "added" }
    });
  }
  return { isTemplate };
}

// Add a template to the user's list, or take it out / decline it.
export async function setUserTemplateStatus(userId: string, documentId: string, status: TemplateStatus) {
  const template = await db.document.findFirst({
    where: { id: documentId, ...accessibleTemplateWhere(userId) },
    select: { id: true }
  });
  if (!template) throw new TemplateError("Template not found.", 404);
  await db.userTemplate.upsert({
    where: { userId_documentId: { userId, documentId } },
    create: { userId, documentId, status },
    update: { status }
  });
  return { status };
}

// Nodes that only work inside the template's own workspace: a widget is a row
// + built files of that document, a repo image is a path in its checkout.
const WORKSPACE_BOUND_NODE_TYPES = new Set(["embeddedWidget", "repoImage"]);

function dropWorkspaceBoundNodes(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node
      .filter(
        (child) =>
          !(
            child &&
            typeof child === "object" &&
            WORKSPACE_BOUND_NODE_TYPES.has(String((child as { type?: unknown }).type))
          )
      )
      .map(dropWorkspaceBoundNodes);
  }
  if (!node || typeof node !== "object") return node;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    output[key] = key === "content" ? dropWorkspaceBoundNodes(value) : value;
  }
  return output;
}

// The content a new document starts with: the template's, minus what belongs
// to the template itself (comment anchors, widgets, repo images).
export function templateContentForNewDocument(rawContent: string): string {
  const content = dropWorkspaceBoundNodes(stripCommentAnchorMarks(parseDocumentContent(rawContent)));
  return serializeDocumentContent(content);
}

// A new document owned by `userId`, started from a template they can open.
// Copies title, content, agent model/effort and the template's skills. Never
// copied: comments, sharing, env vars, the linked repo, schedules.
export async function createDocumentFromTemplate(userId: string, templateId: string) {
  const template = await db.document.findFirst({
    where: { id: templateId, ...accessibleTemplateWhere(userId) },
    select: {
      id: true,
      title: true,
      content: true,
      agentModel: true,
      agentEffort: true,
      skills: { select: { name: true, description: true, catalogName: true, catalogVersion: true } }
    }
  });
  if (!template) throw new TemplateError("Template not found.", 404);

  const document = await db.document.create({
    data: {
      ownerId: userId,
      title: template.title,
      content: templateContentForNewDocument(template.content),
      agentModel: template.agentModel,
      agentEffort: template.agentEffort
    },
    select: { id: true }
  });

  await copyOwnerDefaultSkillsToDocument(userId, document.id);
  for (const skill of template.skills) {
    try {
      await copySkillDir(
        getDocumentSkillDir(template.id, skill.name),
        getDocumentSkillDir(document.id, skill.name)
      );
      await db.documentSkill.upsert({
        where: { documentId_name: { documentId: document.id, name: skill.name } },
        create: { documentId: document.id, createdById: userId, ...skill },
        update: {
          description: skill.description,
          catalogName: skill.catalogName,
          catalogVersion: skill.catalogVersion
        }
      });
    } catch (error) {
      console.warn("[templates] failed to copy a template skill into the new document", {
        templateId: template.id,
        documentId: document.id,
        skill: skill.name,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return document;
}
