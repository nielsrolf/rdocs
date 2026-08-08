import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveDocumentAccess } from "@/lib/permissions";

const voteSchema = z.object({
  // 1 = upvote, -1 = downvote, 0 = clear my vote.
  value: z.union([z.literal(1), z.literal(-1), z.literal(0)])
});

type RouteContext = { params: Promise<{ commentId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const { commentId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const comment = await db.comment.findUnique({
    where: { id: commentId },
    select: { thread: { select: { documentId: true } } }
  });
  if (!comment) {
    return NextResponse.json({ error: "Comment not found." }, { status: 404 });
  }
  const access = await resolveDocumentAccess(comment.thread.documentId, user.id, null);
  if (!access) {
    return NextResponse.json({ error: "You do not have access." }, { status: 403 });
  }
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
