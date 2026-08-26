import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

const patchSchema = z.object({
  commentSlackNotifications: z.boolean().optional(),
  documentShareSlackNotifications: z.boolean().optional(),
  forumShareSlackNotifications: z.boolean().optional(),
  documentCommentPreference: z
    .object({ documentId: z.string().min(1), enabled: z.boolean().nullable() })
    .optional()
}).refine((value) => Object.values(value).some((entry) => entry !== undefined));

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const row = await db.user.findUnique({
    where: { id: user.id },
    select: {
      commentSlackNotifications: true,
      documentShareSlackNotifications: true,
      forumShareSlackNotifications: true
    }
  });
  return NextResponse.json({
    commentSlackNotifications: row?.commentSlackNotifications ?? true,
    documentShareSlackNotifications: row?.documentShareSlackNotifications ?? false,
    forumShareSlackNotifications: row?.forumShareSlackNotifications ?? false
  });
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid settings payload." }, { status: 400 });
  }
  const preference = parsed.data.documentCommentPreference;
  if (preference) {
    const document = await db.document.findFirst({
      where: {
        id: preference.documentId,
        ownerId: { not: user.id },
        OR: [
          { memberships: { some: { userId: user.id } } },
          { groupAccess: { some: { group: { OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] } } } }
        ]
      },
      select: { id: true }
    });
    if (!document) {
      return NextResponse.json({ error: "Document not found or not shared with you." }, { status: 404 });
    }
    if (preference.enabled === null) {
      await db.documentNotificationPreference.deleteMany({
        where: { documentId: preference.documentId, userId: user.id }
      });
    } else {
      await db.documentNotificationPreference.upsert({
        where: { documentId_userId: { documentId: preference.documentId, userId: user.id } },
        create: {
          documentId: preference.documentId,
          userId: user.id,
          commentSlackNotifications: preference.enabled
        },
        update: { commentSlackNotifications: preference.enabled }
      });
    }
  }
  const updated = await db.user.update({
    where: { id: user.id },
    data: {
      ...(parsed.data.commentSlackNotifications === undefined
        ? {}
        : { commentSlackNotifications: parsed.data.commentSlackNotifications }),
      ...(parsed.data.documentShareSlackNotifications === undefined
        ? {}
        : { documentShareSlackNotifications: parsed.data.documentShareSlackNotifications }),
      ...(parsed.data.forumShareSlackNotifications === undefined
        ? {}
        : { forumShareSlackNotifications: parsed.data.forumShareSlackNotifications })
    },
    select: {
      commentSlackNotifications: true,
      documentShareSlackNotifications: true,
      forumShareSlackNotifications: true
    }
  });
  console.log("[comment-notify] settings updated", {
    userId: user.id,
    ...updated,
    documentCommentPreference: preference ?? null
  });
  return NextResponse.json({
    ...updated
  });
}
