import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { serializeComment } from "@/lib/document-data";
import { db } from "@/lib/db";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";

const createReplySchema = z.object({
  body: z.string().min(1).max(4000),
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
    return NextResponse.json({ error: "You must be signed in to reply." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = createReplySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid reply payload." }, { status: 400 });
  }

  const thread = await db.commentThread.findUnique({
    where: { id: threadId },
    select: {
      documentId: true
    }
  });

  if (!thread) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  const access = await resolveDocumentAccess(thread.documentId, user.id, parsed.data.shareToken ?? null);
  if (!access || !canComment(access.permission)) {
    return NextResponse.json({ error: "You do not have comment access." }, { status: 403 });
  }

  const comment = await db.comment.create({
    data: {
      threadId,
      body: parsed.data.body,
      authorId: user.id
    },
    select: {
      id: true,
      body: true,
      aiModel: true,
      sourceLinks: true,
      commitSha: true,
      commitUrl: true,
      aiRunId: true,
      createdAt: true,
      author: {
        select: {
          id: true,
          name: true
        }
      }
    }
  });

  const now = new Date();
  await db.commentThread.update({
    where: { id: threadId },
    data: {
      updatedAt: now
    }
  });
  await db.commentThreadRead.upsert({
    where: { threadId_userId: { threadId, userId: user.id } },
    create: { threadId, userId: user.id, lastReadAt: now },
    update: { lastReadAt: now }
  });

  return NextResponse.json({ comment: serializeComment(comment), lastReadAt: now });
}
