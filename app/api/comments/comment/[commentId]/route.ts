import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { broadcastDocumentEvent } from "@/lib/collaboration";
import { serializeComment } from "@/lib/document-data";
import { db } from "@/lib/db";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";

export const runtime = "nodejs";

const deleteCommentSchema = z.object({
  clientId: z.string().min(1).max(120).optional().nullable(),
  shareToken: z.string().optional().nullable()
});

const editCommentSchema = z.object({
  body: z.string().min(1).max(4000),
  clientId: z.string().min(1).max(120).optional().nullable(),
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    commentId: string;
  }>;
};

// Edit a comment's text. Only the comment's author may edit it (AI comments
// have a null author and are not editable).
export async function PATCH(request: Request, { params }: RouteContext) {
  const { commentId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "You must be signed in to edit comments." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = editCommentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid edit comment payload." }, { status: 400 });
  }

  const comment = await db.comment.findUnique({
    where: { id: commentId },
    select: { id: true, authorId: true, threadId: true, thread: { select: { documentId: true } } }
  });
  if (!comment) {
    return NextResponse.json({ error: "Comment not found." }, { status: 404 });
  }

  const access = await resolveDocumentAccess(comment.thread.documentId, user.id, parsed.data.shareToken ?? null);
  if (!access || !canComment(access.permission)) {
    return NextResponse.json({ error: "You do not have comment access." }, { status: 403 });
  }

  if (comment.authorId !== user.id) {
    return NextResponse.json({ error: "You can only edit your own comments." }, { status: 403 });
  }

  const updated = await db.comment.update({
    where: { id: comment.id },
    data: { body: parsed.data.body },
    select: {
      id: true,
      body: true,
      aiModel: true,
      createdAt: true,
      sourceLinks: true,
      commitSha: true,
      commitUrl: true,
      aiRunId: true,
      author: { select: { id: true, name: true } }
    }
  });

  const serialized = serializeComment(updated);
  broadcastDocumentEvent(
    comment.thread.documentId,
    "comment-updated",
    { threadId: comment.threadId, comment: serialized },
    parsed.data.clientId ?? null
  );

  return NextResponse.json({ comment: serialized });
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const startedAt = Date.now();
  const { commentId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    console.warn("[comment-delete] unauthenticated", { commentId });
    return NextResponse.json({ error: "You must be signed in to delete comments." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = deleteCommentSchema.safeParse(body);
  if (!parsed.success) {
    console.warn("[comment-delete] invalid payload", { commentId, userId: user.id });
    return NextResponse.json({ error: "Invalid delete comment payload." }, { status: 400 });
  }

  const comment = await db.comment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      authorId: true,
      aiModel: true,
      threadId: true,
      thread: {
        select: {
          id: true,
          createdById: true,
          documentId: true,
          document: {
            select: {
              ownerId: true
            }
          },
          comments: {
            orderBy: {
              createdAt: "asc"
            },
            select: {
              id: true
            }
          }
        }
      }
    }
  });

  if (!comment) {
    console.warn("[comment-delete] not found", { commentId, userId: user.id });
    return NextResponse.json({ error: "Comment not found." }, { status: 404 });
  }

  const access = await resolveDocumentAccess(comment.thread.documentId, user.id, parsed.data.shareToken ?? null);
  if (!access || !canComment(access.permission)) {
    console.warn("[comment-delete] forbidden (no access)", { commentId, documentId: comment.thread.documentId, userId: user.id, permission: access?.permission ?? null });
    return NextResponse.json({ error: "You do not have comment access." }, { status: 403 });
  }

  const canDelete =
    comment.thread.document.ownerId === user.id ||
    comment.thread.createdById === user.id ||
    comment.authorId === user.id ||
    (comment.aiModel != null && canComment(access.permission));

  if (!canDelete) {
    console.warn("[comment-delete] forbidden (not owner/author)", { commentId, threadId: comment.thread.id, documentId: comment.thread.documentId, userId: user.id });
    return NextResponse.json({ error: "You cannot delete this comment." }, { status: 403 });
  }

  const remainingCommentIds = comment.thread.comments.filter((entry) => entry.id !== comment.id);

  if (remainingCommentIds.length === 0) {
    await db.commentThread.delete({
      where: {
        id: comment.thread.id
      }
    });

    broadcastDocumentEvent(
      comment.thread.documentId,
      "thread-deleted",
      { threadId: comment.thread.id, deletedCommentId: comment.id },
      parsed.data.clientId ?? null
    );

    console.log("[comment-delete]", {
      commentId: comment.id,
      threadId: comment.thread.id,
      documentId: comment.thread.documentId,
      userId: user.id,
      deletedThread: true,
      elapsedMs: Date.now() - startedAt
    });

    return NextResponse.json({
      deletedCommentId: comment.id,
      deletedThreadId: comment.thread.id
    });
  }

  await db.comment.delete({
    where: {
      id: comment.id
    }
  });

  await db.commentThread.update({
    where: {
      id: comment.thread.id
    },
    data: {
      updatedAt: new Date()
    }
  });

  broadcastDocumentEvent(
    comment.thread.documentId,
    "comment-deleted",
    { threadId: comment.thread.id, commentId: comment.id },
    parsed.data.clientId ?? null
  );

  console.log("[comment-delete]", {
    commentId: comment.id,
    threadId: comment.thread.id,
    documentId: comment.thread.documentId,
    userId: user.id,
    deletedThread: false,
    remainingComments: remainingCommentIds.length,
    elapsedMs: Date.now() - startedAt
  });

  return NextResponse.json({
    deletedCommentId: comment.id,
    deletedThreadId: null
  });
}
