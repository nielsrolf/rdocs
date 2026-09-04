import { NextResponse } from "next/server";
import { z } from "zod";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { castCommentVote, VOTE_KINDS } from "@/lib/forum-votes";

const voteSchema = z.object({
  // 1 = up/agree, -1 = down/disagree, 0 = clear my vote of this kind.
  value: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
  // "karma" (default, the general upvote) or "agreement" (agree/disagree).
  kind: z.enum(VOTE_KINDS).default("karma")
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
  const parsed = voteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid vote payload." }, { status: 400 });
  }
  const tally = await castCommentVote(commentId, gate.user.id, parsed.data.kind, parsed.data.value);
  return NextResponse.json(tally);
}
