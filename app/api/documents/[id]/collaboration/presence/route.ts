import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import {
  pullCollaborationPresence,
  removeCollaborationPresence,
  updateCollaborationPresence
} from "@/lib/collaboration";
import { resolveDocumentAccess } from "@/lib/permissions";

const selectionSchema = z
  .object({
    anchor: z.number().int().nonnegative(),
    head: z.number().int().nonnegative(),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    version: z.number().int().nonnegative()
  })
  .nullable();

const presenceSchema = z.object({
  clientId: z.string().min(1).max(120),
  userName: z.string().min(1).max(120),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  selection: selectionSchema,
  typing: z.boolean(),
  shareToken: z.string().optional().nullable()
});

const removePresenceSchema = z.object({
  clientId: z.string().min(1).max(120),
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const shareToken = new URL(request.url).searchParams.get("share");

  const access = await resolveDocumentAccess(id, user?.id, shareToken);
  if (!access) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const presence = pullCollaborationPresence({
    documentId: id,
    rawContent: access.document.content,
    currentUpdatedAt: access.document.updatedAt
  });

  return NextResponse.json({ presence });
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const body = await request.json().catch(() => null);
  const parsed = presenceSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid presence payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user?.id, parsed.data.shareToken ?? null);
  if (!access) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const presence = updateCollaborationPresence({
    documentId: id,
    rawContent: access.document.content,
    currentUpdatedAt: access.document.updatedAt,
    presence: {
      clientId: parsed.data.clientId,
      userId: user?.id ?? null,
      userName: parsed.data.userName,
      color: parsed.data.color,
      selection: parsed.data.selection,
      typing: parsed.data.typing,
      lastSeen: Date.now()
    }
  });

  return NextResponse.json({ presence });
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const body = await request.json().catch(() => null);
  const parsed = removePresenceSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid presence payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user?.id, parsed.data.shareToken ?? null);
  if (!access) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const presence = removeCollaborationPresence({
    documentId: id,
    rawContent: access.document.content,
    currentUpdatedAt: access.document.updatedAt,
    clientId: parsed.data.clientId
  });

  return NextResponse.json({ presence });
}
