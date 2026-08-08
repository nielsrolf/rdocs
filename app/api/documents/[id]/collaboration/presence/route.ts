import { NextResponse } from "next/server";
import { z } from "zod";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import {
  pullCollaborationPresence,
  removeCollaborationPresence,
  updateCollaborationPresence
} from "@/lib/collaboration";

const positionContextSchema = z.object({
  before: z.string().max(64),
  after: z.string().max(64)
});

const selectionSchema = z
  .object({
    anchor: z.number().int().nonnegative(),
    head: z.number().int().nonnegative(),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
    context: z
      .object({
        from: positionContextSchema,
        to: positionContextSchema,
        head: positionContextSchema
      })
      .optional()
      .nullable()
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

export async function GET(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;

  const gate = await requireDocumentAccess(request, id, "VIEW");
  if (!gate.ok) {
    return gate.response;
  }
  const { access } = gate;

  const presence = pullCollaborationPresence({
    documentId: id,
    rawContent: access.document.content,
    currentUpdatedAt: access.document.updatedAt
  });

  return NextResponse.json({ presence });
}

export async function POST(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = presenceSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid presence payload." }, { status: 400 });
  }

  const gate = await requireDocumentAccess(request, id, "VIEW", {
    shareToken: parsed.data.shareToken ?? null
  });
  if (!gate.ok) {
    return gate.response;
  }
  const { user, access } = gate;

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

export async function DELETE(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = removePresenceSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid presence payload." }, { status: 400 });
  }

  const gate = await requireDocumentAccess(request, id, "VIEW", {
    shareToken: parsed.data.shareToken ?? null
  });
  if (!gate.ok) {
    return gate.response;
  }
  const { access } = gate;

  const presence = removeCollaborationPresence({
    documentId: id,
    rawContent: access.document.content,
    currentUpdatedAt: access.document.updatedAt,
    clientId: parsed.data.clientId
  });

  return NextResponse.json({ presence });
}
