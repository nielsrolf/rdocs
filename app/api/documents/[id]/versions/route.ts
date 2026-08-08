import { NextResponse } from "next/server";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { listDocumentVersions } from "@/lib/document-data";

export async function GET(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const gate = await requireDocumentAccess(request, id, "VIEW");
  if (!gate.ok) {
    return gate.response;
  }

  const versions = await listDocumentVersions(id);
  return NextResponse.json({ versions });
}
