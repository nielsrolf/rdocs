import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { permissionLevels } from "@/lib/contracts";
import { db } from "@/lib/db";
import { getPublicOrigin } from "@/lib/request-origin";

const createShareLinkSchema = z.object({
  documentId: z.string().min(1),
  permission: z.enum(permissionLevels)
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = createShareLinkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid share-link payload." }, { status: 400 });
  }

  const document = await db.document.findUnique({
    where: {
      id: parsed.data.documentId
    },
    select: {
      ownerId: true
    }
  });

  if (!document || document.ownerId !== user.id) {
    return NextResponse.json({ error: "Only the owner can create share links." }, { status: 403 });
  }

  const shareLink = await db.shareLink.create({
    data: {
      documentId: parsed.data.documentId,
      createdById: user.id,
      permission: parsed.data.permission,
      token: randomBytes(18).toString("base64url")
    },
    select: {
      id: true,
      token: true,
      permission: true,
      createdAt: true
    }
  });

  const url = `${getPublicOrigin(request.headers)}/share/${shareLink.token}`;

  return NextResponse.json({ shareLink: { ...shareLink, url } });
}
