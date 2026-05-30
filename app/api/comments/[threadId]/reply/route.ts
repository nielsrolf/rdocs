import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { broadcastDocumentEvent } from "@/lib/collaboration";
import { serializeComment } from "@/lib/document-data";
import { db } from "@/lib/db";
import { syncCommentMentions } from "@/lib/mention-data";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";

const createReplySchema = z.object({
  body: z.string().min(1).max(4000),
  clientId: z.string().min(1).max(120).optional().nullable(),
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    threadId: string;
  }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const startedAt = Date.now();
  const { threadId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    console.warn("[comment-reply] unauthenticated", { threadId });
    return NextResponse.json({ error: "You must be signed in to reply." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = createReplySchema.safeParse(body);
  if (!parsed.success) {
    console.warn("[comment-reply] invalid payload", { threadId, userId: user.id, issues: parsed.error.issues.map((i) => i.path.join(".") + ":" + i.code) });
    return NextResponse.json({ error: "Invalid reply payload." }, { status: 400 });
  }

  const thread = await db.commentThread.findUnique({
    where: { id: threadId },
    select: {
      documentId: true
    }
  });

  if (!thread) {
    console.warn("[comment-reply] thread not found", { threadId, userId: user.id });
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  const access = await resolveDocumentAccess(thread.documentId, user.id, parsed.data.shareToken ?? null);
  if (!access || !canComment(access.permission)) {
    console.warn("[comment-reply] forbidden", { threadId, documentId: thread.documentId, userId: user.id, permission: access?.permission ?? null });
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

  await syncCommentMentions({
    commentId: comment.id,
    documentId: thread.documentId,
    body: parsed.data.body,
    authorId: user.id
  });

  const serialized = serializeComment(comment);
  broadcastDocumentEvent(
    thread.documentId,
    "comment-created",
    { threadId, comment: serialized },
    parsed.data.clientId ?? null
  );

  console.log("[comment-reply]", {
    threadId,
    documentId: thread.documentId,
    userId: user.id,
    commentId: comment.id,
    bodyBytes: parsed.data.body.length,
    elapsedMs: Date.now() - startedAt
  });

  return NextResponse.json({ comment: serialized, lastReadAt: now });
}
