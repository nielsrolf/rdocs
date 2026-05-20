import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getRequestOrigin } from "@/lib/request-origin";

type RouteContext = {
  params: Promise<{
    token: string;
  }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const { token } = await params;
  const shareLink = await db.shareLink.findUnique({
    where: { token },
    select: {
      token: true,
      revokedAt: true,
      documentId: true
    }
  });

  const base = getRequestOrigin(request);
  if (!shareLink || shareLink.revokedAt) {
    return NextResponse.redirect(new URL("/", base));
  }

  return NextResponse.redirect(new URL(`/documents/${shareLink.documentId}?share=${shareLink.token}`, base));
}
