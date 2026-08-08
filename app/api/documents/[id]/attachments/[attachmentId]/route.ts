import fs from "node:fs/promises";

import { NextResponse } from "next/server";

import { getAttachmentStorePath } from "@/lib/attachments";
import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// RFC 5987 / 6266 filename encoding so non-ASCII names survive the header.
function contentDisposition(fileName: string) {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function GET(
  request: Request,
  { params }: RouteContext<{ id: string; attachmentId: string }>
) {
  const { id, attachmentId } = await params;

  const gate = await requireDocumentAccess(request, id, "VIEW");
  if (!gate.ok) {
    return gate.response;
  }

  const attachment = await db.attachment.findFirst({
    where: { id: attachmentId, documentId: id }
  });
  if (!attachment) {
    return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
  }

  const bytes = await fs.readFile(getAttachmentStorePath(id, attachment.storedName)).catch(() => null);
  if (!bytes) {
    return NextResponse.json({ error: "Attachment file is missing." }, { status: 404 });
  }

  return new NextResponse(bytes, {
    headers: {
      "Content-Type": attachment.mimeType || "application/octet-stream",
      "Content-Disposition": contentDisposition(attachment.fileName),
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=60"
    }
  });
}
