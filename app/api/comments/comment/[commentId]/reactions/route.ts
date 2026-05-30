import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { broadcastDocumentEvent } from "@/lib/collaboration";
import { db } from "@/lib/db";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";
import { aggregateReactions, isReactionEmoji, type RawReaction } from "@/lib/reactions";

export const runtime = "nodejs";

const toggleSchema = z.object({
  emoji: z.string().min(1).max(16),
  clientId: z.string().min(1).max(120).optional().nullable(),
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{ commentId: string }>;
};

// Toggle an emoji reaction on a comment for the current user: adds it if absent,
// removes it if already present. Anyone with comment access (COMMENT or EDIT)
// may react; anonymous share visitors cannot (no user identity).
export async function POST(request: Request, { params }: RouteContext) {
  const { commentId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "You must be signed in to react." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = toggleSchema.safeParse(body);
  if (!parsed.success || !isReactionEmoji(parsed.data.emoji)) {
    return NextResponse.json({ error: "Invalid reaction." }, { status: 400 });
  }

  const comment = await db.comment.findUnique({
    where: { id: commentId },
    select: { id: true, threadId: true, thread: { select: { documentId: true } } }
  });
  if (!comment) {
    return NextResponse.json({ error: "Comment not found." }, { status: 404 });
  }

  const access = await resolveDocumentAccess(
    comment.thread.documentId,
    user.id,
    parsed.data.shareToken ?? null
  );
  if (!access || !canComment(access.permission)) {
    return NextResponse.json({ error: "You do not have comment access." }, { status: 403 });
  }

  const emoji = parsed.data.emoji;
  const existing = await db.commentReaction.findUnique({
    where: { commentId_userId_emoji: { commentId, userId: user.id, emoji } },
    select: { id: true }
  });
  if (existing) {
    await db.commentReaction.delete({ where: { id: existing.id } });
  } else {
    await db.commentReaction.create({ data: { commentId, userId: user.id, emoji } });
  }

  const rows: RawReaction[] = await db.commentReaction.findMany({
    where: { commentId },
    select: { emoji: true, userId: true, user: { select: { name: true } } }
  });

  // Broadcast the raw rows so every other client can recompute "reactedByMe"
  // against its own viewer; reactions are per-user and not interchangeable.
  broadcastDocumentEvent(
    comment.thread.documentId,
    "comment-reaction",
    { threadId: comment.threadId, commentId, reactions: rows },
    parsed.data.clientId ?? null
  );

  return NextResponse.json({
    commentId,
    threadId: comment.threadId,
    reactions: aggregateReactions(rows, user.id)
  });
}
