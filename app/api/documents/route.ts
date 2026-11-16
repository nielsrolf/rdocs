import { NextResponse } from "next/server";

import { defaultDocumentContent, serializeDocumentContent } from "@/lib/content";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { copyOwnerDefaultSkillsToDocument } from "@/lib/document-skills";
import { createDocumentFromTemplate, TemplateError } from "@/lib/templates";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const [owned, shared] = await Promise.all([
    db.document.findMany({
      where: { ownerId: user.id },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { id: true, title: true, updatedAt: true }
    }),
    db.documentMembership.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: {
        document: { select: { id: true, title: true, updatedAt: true } }
      }
    })
  ]);

  const merged = [
    ...owned.map((d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt, source: "owned" as const })),
    ...shared.map(({ document }) => ({
      id: document.id,
      title: document.title,
      updatedAt: document.updatedAt,
      source: "shared" as const
    }))
  ]
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 12)
    .map((d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt.toISOString(), source: d.source }));

  return NextResponse.json({ documents: merged });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  // Optional body { templateId }: start from a template the user can open.
  // No body (the old callers) = a blank document.
  const body = (await request.json().catch(() => null)) as { templateId?: unknown } | null;
  if (typeof body?.templateId === "string" && body.templateId) {
    try {
      const created = await createDocumentFromTemplate(user.id, body.templateId);
      return NextResponse.json({ id: created.id });
    } catch (error) {
      if (error instanceof TemplateError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  }

  const document = await db.document.create({
    data: {
      ownerId: user.id,
      title: "Untitled document",
      content: serializeDocumentContent(defaultDocumentContent)
    },
    select: {
      id: true
    }
  });

  await copyOwnerDefaultSkillsToDocument(user.id, document.id);

  return NextResponse.json({ id: document.id });
}
