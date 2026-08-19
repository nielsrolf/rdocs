import { NextResponse } from "next/server";
import { z } from "zod";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { db } from "@/lib/db";

const schema = z.object({
  shareToken: z.string().optional().nullable()
});

export async function POST(request: Request, { params }: RouteContext<{ threadId: string }>) {
  const { threadId } = await params;

  const body = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  const thread = await db.commentThread.findUnique({
    where: { id: threadId },
    select: { documentId: true }
  });
  if (!thread) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  const gate = await requireDocumentAccess(request, thread.documentId, "COMMENT", {
    shareToken: parsed.data.shareToken ?? null,
    requireUser: true,
    forbiddenMessage: "You do not have access."
  });
  if (!gate.ok) {
    return gate.response;
  }
  const { user } = gate;

  const now = new Date();
  await db.commentThreadRead.upsert({
    where: { threadId_userId: { threadId, userId: user.id } },
    create: { threadId, userId: user.id, lastReadAt: now },
    update: { lastReadAt: now }
  });

  return NextResponse.json({ lastReadAt: now });
}
