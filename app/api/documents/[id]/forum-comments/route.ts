import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { listForumComments } from "@/lib/forum-data";
import { resolveDocumentAccess } from "@/lib/permissions";

type RouteContext = { params: Promise<{ id: string }> };

// Nested forum-view comment tree for a document (studio threads included,
// carrying their anchor quote). Used by the forum page to refresh after
// posting.
export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const access = await resolveDocumentAccess(id, user?.id, null);
  if (!access) {
    return NextResponse.json({ error: "You do not have access." }, { status: user ? 403 : 401 });
  }
  const comments = await listForumComments(id, user?.id ?? null);
  return NextResponse.json({ comments });
}
