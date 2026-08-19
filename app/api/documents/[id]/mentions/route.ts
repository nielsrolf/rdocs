import { NextResponse } from "next/server";
import { z } from "zod";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { recordDocumentMention } from "@/lib/mention-data";

const schema = z.object({
  mentionedUserId: z.string().min(1).max(100),
  shareToken: z.string().optional().nullable()
});

// Records an @mention typed into the document body so the mentioned member gets
// a dashboard notification (parity with comment mentions). The editor posts here
// when a mention is inserted via autocomplete.
export async function POST(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid mention payload." }, { status: 400 });
  }

  const gate = await requireDocumentAccess(request, id, "COMMENT", {
    shareToken: parsed.data.shareToken ?? null,
    requireUser: true,
    forbiddenMessage: "You do not have access."
  });
  if (!gate.ok) {
    return gate.response;
  }
  const { user } = gate;

  const recorded = await recordDocumentMention({
    documentId: id,
    mentionedUserId: parsed.data.mentionedUserId,
    authorId: user.id
  });
  return NextResponse.json({ recorded });
}
