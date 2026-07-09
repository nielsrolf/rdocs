import { NextResponse } from "next/server";

import { defaultDocumentContent, serializeDocumentContent } from "@/lib/content";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { copyOwnerDefaultSkillsToDocument } from "@/lib/document-skills";

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

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
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
