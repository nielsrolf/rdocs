import { NextResponse } from "next/server";
import { z } from "zod";

import { notifyForumMentioned } from "@/lib/activity-notifications";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { syncForumDocumentMentions } from "@/lib/mention-data";
import { deleteQuicktake, QUICKTAKE_MAX_LENGTH, QuicktakeError, updateQuicktake } from "@/lib/quicktakes";

type RouteContext = { params: Promise<{ id: string }> };

const editSchema = z.object({
  body: z.string().min(1).max(QUICKTAKE_MAX_LENGTH)
});

// Owner-only body edit. Mentions are re-synced; only people mentioned for the
// first time by this edit are notified.
export async function PATCH(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const parsed = editSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid quicktake payload." }, { status: 400 });
  }
  try {
    const previouslyMentioned = new Set(
      (
        await db.documentMention.findMany({
          where: { documentId: id },
          select: { mentionedUserId: true }
        })
      ).map((row) => row.mentionedUserId)
    );
    const quicktake = await updateQuicktake(user.id, id, parsed.data.body);
    if (!quicktake) {
      return NextResponse.json({ error: "Quicktake not found." }, { status: 404 });
    }
    const mentionedUserIds = await syncForumDocumentMentions({
      documentId: id,
      body: parsed.data.body,
      authorId: user.id
    });
    void notifyForumMentioned({
      documentId: id,
      recipientUserIds: mentionedUserIds.filter((userId) => !previouslyMentioned.has(userId)),
      authorLabel: user.name,
      kind: "quicktake"
    });
    console.log("[quicktake] edited", { quicktakeId: id, userId: user.id });
    return NextResponse.json({ quicktake });
  } catch (error) {
    if (error instanceof QuicktakeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

// Owner-only delete; the document cascade removes votes, threads, and grants.
export async function DELETE(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const deleted = await deleteQuicktake(user.id, id);
  if (!deleted) {
    return NextResponse.json({ error: "Quicktake not found." }, { status: 404 });
  }
  console.log("[quicktake] deleted", { quicktakeId: id, userId: user.id });
  return NextResponse.json({ ok: true });
}
