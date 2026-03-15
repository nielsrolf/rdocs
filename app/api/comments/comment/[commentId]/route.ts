import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";

export const runtime = "nodejs";

const deleteCommentSchema = z.object({
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    commentId: string;
  }>;
};

export async function DELETE(request: Request, { params }: RouteContext) {
  const { commentId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "You must be signed in to delete comments." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = deleteCommentSchema.safeParse(body);
  if (!parsed.success) {
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
    return NextResponse.json({ error: "Comment not found." }, { status: 404 });
  }

  const access = await resolveDocumentAccess(comment.thread.documentId, user.id, parsed.data.shareToken ?? null);
  if (!access || !canComment(access.permission)) {
    return NextResponse.json({ error: "You do not have comment access." }, { status: 403 });
  }

  const canDelete =
    comment.thread.document.ownerId === user.id ||
    comment.thread.createdById === user.id ||
    comment.authorId === user.id ||
    (comment.aiModel != null && canComment(access.permission));

  if (!canDelete) {
    return NextResponse.json({ error: "You cannot delete this comment." }, { status: 403 });
  }

  const remainingCommentIds = comment.thread.comments.filter((entry) => entry.id !== comment.id);

  if (remainingCommentIds.length === 0) {
    await db.commentThread.delete({
      where: {
        id: comment.thread.id
      }
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

  return NextResponse.json({
    deletedCommentId: comment.id,
    deletedThreadId: null
  });
}
