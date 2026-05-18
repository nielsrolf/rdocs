import fs from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveDocumentAccess } from "@/lib/permissions";
import { ensureLinkedRepository } from "@/lib/research-workspace";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
    widgetId: string;
  }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const { id, widgetId } = await params;
  const user = await getCurrentUser();
  const shareToken = new URL(request.url).searchParams.get("share");
  const access = await resolveDocumentAccess(id, user?.id, shareToken);

  if (!access) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const widget = await db.embeddedWidget.findFirst({
    where: {
      id: widgetId,
      documentId: id
    }
  });

  if (!widget) {
    return NextResponse.json({ error: "Widget not found." }, { status: 404 });
  }

  const linkedRepo = await ensureLinkedRepository(id, { requireClean: false });
  if (!linkedRepo) {
    return NextResponse.json({ error: "Repository is not linked." }, { status: 400 });
  }

  const sourcePath = path.resolve(linkedRepo.workspace, widget.embedSource);
  const workspaceRoot = path.resolve(linkedRepo.workspace);
  if (!sourcePath.startsWith(`${workspaceRoot}${path.sep}`)) {
    return NextResponse.json({ error: "Widget source must be inside the linked repository." }, { status: 400 });
  }

  try {
    const html = await fs.readFile(sourcePath, "utf8");
    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'self' 'unsafe-inline' data: blob:; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"
      }
    });
  } catch {
    return NextResponse.json({ error: "Widget source file was not found." }, { status: 404 });
  }
}
