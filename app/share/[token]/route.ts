import { NextResponse } from "next/server";

import { db } from "@/lib/db";

type RouteContext = {
  params: Promise<{
    token: string;
  }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  const { token } = await params;
  const shareLink = await db.shareLink.findUnique({
    where: { token },
    select: {
      token: true,
      revokedAt: true,
      documentId: true
    }
  });

  if (!shareLink || shareLink.revokedAt) {
    return NextResponse.redirect(new URL("/", _request.url));
  }

  return NextResponse.redirect(new URL(`/documents/${shareLink.documentId}?share=${shareLink.token}`, _request.url));
}
