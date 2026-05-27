import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";

const schema = z.object({
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    threadId: string;
  }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const { threadId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }

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

  const access = await resolveDocumentAccess(thread.documentId, user.id, parsed.data.shareToken ?? null);
  if (!access || !canComment(access.permission)) {
    return NextResponse.json({ error: "You do not have access." }, { status: 403 });
  }

  const now = new Date();
  await db.commentThreadRead.upsert({
    where: { threadId_userId: { threadId, userId: user.id } },
    create: { threadId, userId: user.id, lastReadAt: now },
    update: { lastReadAt: now }
  });

  return NextResponse.json({ lastReadAt: now });
}
