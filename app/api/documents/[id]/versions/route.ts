import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { listDocumentVersions } from "@/lib/document-data";
import { resolveDocumentAccess } from "@/lib/permissions";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const shareToken = new URL(request.url).searchParams.get("share");
  const access = await resolveDocumentAccess(id, user?.id, shareToken);

  if (!access) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const versions = await listDocumentVersions(id);
  return NextResponse.json({ versions });
}
