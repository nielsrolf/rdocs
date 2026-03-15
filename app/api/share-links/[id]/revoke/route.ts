import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const link = await db.shareLink.findUnique({
    where: { id },
    select: {
      document: {
        select: {
          ownerId: true
        }
      }
    }
  });

  if (!link || link.document.ownerId !== user.id) {
    return NextResponse.json({ error: "Only the owner can revoke share links." }, { status: 403 });
  }

  await db.shareLink.update({
    where: { id },
    data: {
      revokedAt: new Date()
    }
  });

  return NextResponse.json({ ok: true });
}
