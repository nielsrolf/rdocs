import { NextResponse } from "next/server";

import {
  getAttachmentWorkspacePath,
  saveAttachmentToStore
} from "@/lib/attachments";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";

export const runtime = "nodejs";

// Keep uploads well under the Cloudflare/Next body limits and avoid filling disk.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

function serializeAttachment(attachment: {
  id: string;
  fileName: string;
  storedName: string;
  mimeType: string;
  size: number;
  createdAt: Date;
}) {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    workspacePath: getAttachmentWorkspacePath(attachment.storedName),
    createdAt: attachment.createdAt.toISOString()
  };
}

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const shareToken = new URL(request.url).searchParams.get("share");

  const access = await resolveDocumentAccess(id, user?.id, shareToken);
  if (!access) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const attachments = await db.attachment.findMany({
    where: { documentId: id },
    orderBy: { createdAt: "asc" }
  });

  return NextResponse.json({ attachments: attachments.map(serializeAttachment) });
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");
  const shareToken = typeof formData?.get("share") === "string" ? (formData.get("share") as string) : null;

  const access = await resolveDocumentAccess(id, user?.id, shareToken);
  if (!access || !canEdit(access.permission)) {
    return NextResponse.json({ error: "You do not have edit access." }, { status: 403 });
  }

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file." }, { status: 400 });
  }

  if (file.size > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json({ error: "Attachment exceeds the 25 MB limit." }, { status: 413 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const { storedName } = await saveAttachmentToStore(id, file.name || "attachment", bytes);

  const attachment = await db.attachment.create({
    data: {
      documentId: id,
      fileName: file.name || storedName,
      storedName,
      mimeType: file.type || "application/octet-stream",
      size: bytes.length,
      createdById: user?.id ?? null
    }
  });

  return NextResponse.json({ attachment: serializeAttachment(attachment) });
}
