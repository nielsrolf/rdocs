import { NextResponse } from "next/server";
import { z } from "zod";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { db } from "@/lib/db";

const voteSchema = z.object({
  // 1 = upvote, -1 = downvote, 0 = clear my vote.
  value: z.union([z.literal(1), z.literal(-1), z.literal(0)])
});

export async function POST(request: Request, { params }: RouteContext<{ commentId: string }>) {
  const { commentId } = await params;
  const comment = await db.comment.findUnique({
    where: { id: commentId },
    select: { thread: { select: { documentId: true } } }
  });
  if (!comment) {
    return NextResponse.json({ error: "Comment not found." }, { status: 404 });
  }
  const gate = await requireDocumentAccess(request, comment.thread.documentId, "VIEW", {
    shareToken: null,
    requireUser: true
  });
  if (!gate.ok) {
    return gate.response;
  }
  const { user } = gate;
  const parsed = voteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid vote payload." }, { status: 400 });
  }
  if (parsed.data.value === 0) {
    await db.commentVote.deleteMany({ where: { commentId, userId: user.id } });
  } else {
    await db.commentVote.upsert({
      where: { commentId_userId: { commentId, userId: user.id } },
      create: { commentId, userId: user.id, value: parsed.data.value },
      update: { value: parsed.data.value }
    });
  }
  const agg = await db.commentVote.aggregate({ where: { commentId }, _sum: { value: true } });
  return NextResponse.json({ score: agg._sum.value ?? 0, ownVote: parsed.data.value });
}
