import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { recordDocumentMention } from "@/lib/mention-data";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";

const schema = z.object({
  mentionedUserId: z.string().min(1).max(100),
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{ id: string }>;
};

// Records an @mention typed into the document body so the mentioned member gets
// a dashboard notification (parity with comment mentions). The editor posts here
// when a mention is inserted via autocomplete.
export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid mention payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user.id, parsed.data.shareToken ?? null);
  if (!access || !canComment(access.permission)) {
    return NextResponse.json({ error: "You do not have access." }, { status: 403 });
  }

  const recorded = await recordDocumentMention({
    documentId: id,
    mentionedUserId: parsed.data.mentionedUserId,
    authorId: user.id
  });
  return NextResponse.json({ recorded });
}
