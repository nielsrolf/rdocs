import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { serializeDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";

const updateDocumentSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.unknown(),
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function PATCH(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const body = await request.json().catch(() => null);
  const parsed = updateDocumentSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid document update payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user?.id, parsed.data.shareToken ?? null);
  if (!access || !canEdit(access.permission)) {
    return NextResponse.json({ error: "You do not have edit access." }, { status: 403 });
  }

  const updated = await db.document.update({
    where: { id },
    data: {
      title: parsed.data.title.trim(),
      content: serializeDocumentContent(parsed.data.content)
    },
    select: {
      updatedAt: true
    }
  });

  return NextResponse.json({ ok: true, updatedAt: updated.updatedAt });
}
