import { NextResponse } from "next/server";
import { z } from "zod";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { db } from "@/lib/db";

const voteSchema = z.object({
  // 1 = upvote, -1 = downvote, 0 = clear my vote.
  value: z.union([z.literal(1), z.literal(-1), z.literal(0)])
});

export async function POST(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const gate = await requireDocumentAccess(request, id, "VIEW", {
    shareToken: null,
    requireUser: true
  });
  if (!gate.ok) {
    return gate.response;
  }
  const user = gate.user;
  const parsed = voteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid vote payload." }, { status: 400 });
  }
  if (parsed.data.value === 0) {
    await db.documentVote.deleteMany({ where: { documentId: id, userId: user.id } });
  } else {
    await db.documentVote.upsert({
      where: { documentId_userId: { documentId: id, userId: user.id } },
      create: { documentId: id, userId: user.id, value: parsed.data.value },
      update: { value: parsed.data.value }
    });
  }
  const agg = await db.documentVote.aggregate({ where: { documentId: id }, _sum: { value: true } });
  return NextResponse.json({ score: agg._sum.value ?? 0, ownVote: parsed.data.value });
}
