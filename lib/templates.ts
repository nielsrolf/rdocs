import type { Prisma } from "@prisma/client";

import { parseDocumentContent, serializeDocumentContent, stripCommentAnchorMarks } from "@/lib/content";
import { db } from "@/lib/db";
import { copyOwnerDefaultSkillsToDocument } from "@/lib/document-skills";
import { copySkillDir, getDocumentSkillDir } from "@/lib/skills";

// Templates. "Template" is a property of the USER–DOCUMENT relation, not of
// the document: a `UserTemplate` row with status "added" puts a document the
// user can open under their "New document" options (File menu → "Use this doc
// as a template", or Settings → Templates). Any document they can open
// qualifies, their own or one shared with them.
//
// When a document's OWNER uses it as a template, everyone else it is shared
// with and who has no row yet is asked whether they want it too (dashboard +
// inside the document); "dismissed" records a no, so each one asks once.
//
// A template is only ever usable or listed while the user can still open the
// document: every query goes through `accessibleDocumentWhere`, so revoking
// access silently takes it out of every list. `Document.isTemplate` is an
// unused leftover column of the first version.

export type TemplateStatus = "added" | "dismissed";

export type TemplateListing = {
  id: string;
  title: string;
  ownerName: string;
  isOwner: boolean;
  // null = the owner uses it as a template and this user was not asked yet
  // (an open offer).
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

function accessibleDocumentWhere(userId: string): Prisma.DocumentWhereInput {
  return {
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

type TemplateUserRow = { userId: string; status: string };

// The viewer's own decision, and whether the owner's use of the document as a
// template makes it an open offer for them.
function templateStateFromRows(rows: TemplateUserRow[], ownerId: string, userId: string) {
  const status = normalizeStatus(rows.find((row) => row.userId === userId)?.status);
  const ownerUsesIt = rows.some((row) => row.userId === ownerId && row.status === "added");
  return { status, offer: status === null && ownerId !== userId && ownerUsesIt };
}

// Every document the user decided about, plus the open offers. Added ones
// first, then open offers, then dismissed; alphabetical within each.
export async function listTemplatesForUser(userId: string): Promise<TemplateListing[]> {
  const rows = await db.document.findMany({
    where: {
      ...accessibleDocumentWhere(userId),
      templateUsers: { some: { OR: [{ userId }, { status: "added" }] } }
    },
    select: {
      id: true,
      title: true,
      ownerId: true,
      owner: { select: { name: true } },
      templateUsers: {
        where: { OR: [{ userId }, { status: "added" }] },
        select: { userId: true, status: true }
      }
    }
  });
  const rank = (status: TemplateStatus | null) => (status === "added" ? 0 : status === null ? 1 : 2);
  const listings: TemplateListing[] = [];
  for (const row of rows) {
    const state = templateStateFromRows(row.templateUsers, row.ownerId, userId);
    if (state.status === null && !state.offer) continue;
    listings.push({
      id: row.id,
      title: row.title,
      ownerName: row.owner.name,
      isOwner: row.ownerId === userId,
      status: state.status
    });
  }
  return listings.sort((a, b) => rank(a.status) - rank(b.status) || a.title.localeCompare(b.title));
}

// The "New document" options.
export async function listAddedTemplates(userId: string): Promise<TemplateListing[]> {
  return (await listTemplatesForUser(userId)).filter((template) => template.status === "added");
}

// Templates of an owner who shared the document with the user, not decided yet.
export async function listTemplateOffers(userId: string): Promise<TemplateListing[]> {
  return (await listTemplatesForUser(userId)).filter((template) => template.status === null);
}

// What the document page needs: does this viewer use the document as a
// template, and should they be asked (`offer`).
export async function getTemplateStateForViewer(documentId: string, userId: string | null) {
  if (!userId) return { isTemplate: false, status: null, offer: false };
  const row = await db.document.findUnique({
    where: { id: documentId },
    select: {
      ownerId: true,
      templateUsers: {
        where: { OR: [{ userId }, { status: "added" }] },
        select: { userId: true, status: true }
      }
    }
  });
  if (!row) return { isTemplate: false, status: null, offer: false };
  const state = templateStateFromRows(row.templateUsers, row.ownerId, userId);
  return { isTemplate: state.status === "added", ...state };
}

// Use a document as a template ("added"), or stop / decline ("dismissed").
// Works for any regular document the user can open.
export async function setUserTemplateStatus(userId: string, documentId: string, status: TemplateStatus) {
  const document = await db.document.findFirst({
    where: { id: documentId, ...accessibleDocumentWhere(userId) },
    select: { id: true }
  });
  if (!document) throw new TemplateError("Document not found.", 404);
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

// A new document owned by `userId`, started from a document they can open.
// Copies title, content, agent model/effort and the template's skills. Never
// copied: comments, sharing, env vars, the linked repo, schedules.
export async function createDocumentFromTemplate(userId: string, templateId: string) {
  const template = await db.document.findFirst({
    where: { id: templateId, ...accessibleDocumentWhere(userId) },
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
