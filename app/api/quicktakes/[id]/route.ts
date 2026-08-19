import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { deleteQuicktake } from "@/lib/quicktakes";

type RouteContext = { params: Promise<{ id: string }> };

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
