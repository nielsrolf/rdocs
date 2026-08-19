import { NextResponse } from "next/server";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { listForumComments } from "@/lib/forum-data";

// Nested forum-view comment tree for a document (studio threads included,
// carrying their anchor quote). Used by the forum page to refresh after
// posting.
export async function GET(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const gate = await requireDocumentAccess(request, id, "VIEW", { shareToken: null });
  if (!gate.ok) {
    return gate.response;
  }
  const comments = await listForumComments(id, gate.user?.id ?? null);
  return NextResponse.json({ comments });
}
