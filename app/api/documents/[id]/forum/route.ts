import { NextResponse } from "next/server";
import { z } from "zod";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { db } from "@/lib/db";

const postSchema = z.object({
  posted: z.boolean().optional(),
  // Posted + public: readable by everyone, including logged-out visitors.
  isPublic: z.boolean().optional()
});

// Toggle the "posted to forum" flag. Posting does NOT widen access — the forum
// shows a doc only to users who could already open it.
export async function POST(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const gate = await requireDocumentAccess(request, id, "EDIT", {
    shareToken: null,
    requireUser: true,
    forbiddenMessage: "You do not have edit access."
  });
  if (!gate.ok) {
    return gate.response;
  }
  const { user, access } = gate;
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid forum payload." }, { status: 400 });
  }
  // Re-posting an already-posted doc keeps the original post date.
  const posted = parsed.data.posted ?? Boolean(access.document.forumPostedAt);
  const forumPostedAt = posted ? access.document.forumPostedAt ?? new Date() : null;
  // Unposting always revokes public visibility; otherwise keep unless changed.
  const forumPublic = posted ? parsed.data.isPublic ?? access.document.forumPublic : false;
  await db.document.update({ where: { id }, data: { forumPostedAt, forumPublic } });
  console.log("[forum] post flag", {
    documentId: id,
    userId: user.id,
    posted,
    isPublic: forumPublic
  });
  return NextResponse.json({ forumPostedAt, forumPublic });
}
