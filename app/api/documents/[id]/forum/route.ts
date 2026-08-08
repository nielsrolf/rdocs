import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";

const postSchema = z.object({
  posted: z.boolean().optional(),
  // Posted + public: readable by everyone, including logged-out visitors.
  isPublic: z.boolean().optional()
});

type RouteContext = { params: Promise<{ id: string }> };

// Toggle the "posted to forum" flag. Posting does NOT widen access — the forum
// shows a doc only to users who could already open it.
export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const access = await resolveDocumentAccess(id, user.id, null);
  if (!access || !canEdit(access.permission)) {
    return NextResponse.json({ error: "You do not have edit access." }, { status: 403 });
  }
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
