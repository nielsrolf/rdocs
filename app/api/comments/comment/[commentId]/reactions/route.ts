import { NextResponse } from "next/server";
import { z } from "zod";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { broadcastDocumentEvent } from "@/lib/collaboration";
import { db } from "@/lib/db";
import { toggleCommentReaction } from "@/lib/reaction-data";
import { aggregateReactions, isReactionEmoji } from "@/lib/reactions";

export const runtime = "nodejs";

const toggleSchema = z.object({
  emoji: z.string().min(1).max(16),
  clientId: z.string().min(1).max(120).optional().nullable(),
  shareToken: z.string().optional().nullable()
});

// Toggle an emoji reaction on a comment for the current user: adds it if absent,
// removes it if already present. Anyone with comment access (COMMENT or EDIT)
// may react; anonymous share visitors cannot (no user identity).
export async function POST(request: Request, { params }: RouteContext<{ commentId: string }>) {
  const { commentId } = await params;

  const body = await request.json().catch(() => null);
  const parsed = toggleSchema.safeParse(body);
  if (!parsed.success || !isReactionEmoji(parsed.data.emoji)) {
    return NextResponse.json({ error: "Invalid reaction." }, { status: 400 });
  }

  const comment = await db.comment.findUnique({
    where: { id: commentId },
    select: { id: true, threadId: true, thread: { select: { documentId: true, origin: true } } }
  });
  if (!comment) {
    return NextResponse.json({ error: "Comment not found." }, { status: 404 });
  }

  const gate = await requireDocumentAccess(request, comment.thread.documentId, "COMMENT", {
    shareToken: parsed.data.shareToken ?? null,
    requireUser: true,
    forbiddenMessage: "You do not have comment access."
  });
  if (!gate.ok) {
    return gate.response;
  }
  const { user } = gate;

  const { rows, deletedThreadId } = await toggleCommentReaction({
    commentId,
    threadId: comment.threadId,
    threadOrigin: comment.thread.origin,
    userId: user.id,
    emoji: parsed.data.emoji
  });

  if (deletedThreadId) {
    // The last reaction on a text reaction went away, and the thread with it.
    broadcastDocumentEvent(
      comment.thread.documentId,
      "thread-deleted",
      { threadId: deletedThreadId, deletedCommentId: commentId },
      parsed.data.clientId ?? null
    );
    return NextResponse.json({ commentId, threadId: comment.threadId, reactions: [], deletedThreadId });
  }

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
    reactions: aggregateReactions(rows, user.id),
    deletedThreadId: null
  });
}
