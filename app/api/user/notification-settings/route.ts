import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  COMMENT_NOTIFICATION_SCOPES,
  legacyBooleanForScope,
  userDefaultCommentScope
} from "@/lib/notification-preferences";

const scopeSchema = z.enum(COMMENT_NOTIFICATION_SCOPES);

const patchSchema = z
  .object({
    // Legacy boolean, still accepted from old clients: false = scope "none".
    commentSlackNotifications: z.boolean().optional(),
    commentNotificationScope: scopeSchema.optional(),
    documentShareSlackNotifications: z.boolean().optional(),
    forumShareSlackNotifications: z.boolean().optional(),
    forumPostSlackNotifications: z.boolean().optional(),
    documentCommentPreference: z
      .object({
        documentId: z.string().min(1),
        // `scope: null` (or `enabled: null`) clears the per-document override.
        scope: scopeSchema.nullable().optional(),
        enabled: z.boolean().nullable().optional()
      })
      .optional()
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined));

function selection() {
  return {
    commentSlackNotifications: true,
    commentNotificationScope: true,
    documentShareSlackNotifications: true,
    forumShareSlackNotifications: true,
    forumPostSlackNotifications: true
  } as const;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const row = await db.user.findUnique({ where: { id: user.id }, select: selection() });
  return NextResponse.json({
    commentNotificationScope: userDefaultCommentScope(row ?? {}),
    commentSlackNotifications: row?.commentSlackNotifications ?? true,
    documentShareSlackNotifications: row?.documentShareSlackNotifications ?? false,
    forumShareSlackNotifications: row?.forumShareSlackNotifications ?? false,
    forumPostSlackNotifications: row?.forumPostSlackNotifications ?? true
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
        OR: [
          { ownerId: user.id },
          { memberships: { some: { userId: user.id } } },
          { groupAccess: { some: { group: { OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] } } } },
          // Public forum items can be subscribed to by anyone who can read them.
          { forumPublic: true }
        ]
      },
      select: { id: true }
    });
    if (!document) {
      return NextResponse.json({ error: "Document not found or unavailable." }, { status: 404 });
    }
    // Old clients send `enabled` (true = every comment, false = mute).
    const scope =
      preference.scope !== undefined
        ? preference.scope
        : preference.enabled === undefined || preference.enabled === null
          ? null
          : preference.enabled
            ? "all"
            : "none";
    if (scope === null) {
      await db.documentNotificationPreference.deleteMany({
        where: { documentId: preference.documentId, userId: user.id }
      });
    } else {
      await db.documentNotificationPreference.upsert({
        where: { documentId_userId: { documentId: preference.documentId, userId: user.id } },
        create: {
          documentId: preference.documentId,
          userId: user.id,
          commentScope: scope,
          commentSlackNotifications: legacyBooleanForScope(scope)
        },
        update: { commentScope: scope, commentSlackNotifications: legacyBooleanForScope(scope) }
      });
    }
  }
  // A scope always rewrites the legacy boolean mirror, so a draining old-code
  // sibling still behaves sanely during a blue/green overlap.
  const scope =
    parsed.data.commentNotificationScope ??
    (parsed.data.commentSlackNotifications === undefined
      ? undefined
      : parsed.data.commentSlackNotifications
        ? "participating"
        : "none");
  const updated = await db.user.update({
    where: { id: user.id },
    data: {
      ...(scope === undefined
        ? {}
        : { commentNotificationScope: scope, commentSlackNotifications: legacyBooleanForScope(scope) }),
      ...(parsed.data.documentShareSlackNotifications === undefined
        ? {}
        : { documentShareSlackNotifications: parsed.data.documentShareSlackNotifications }),
      ...(parsed.data.forumShareSlackNotifications === undefined
        ? {}
        : { forumShareSlackNotifications: parsed.data.forumShareSlackNotifications }),
      ...(parsed.data.forumPostSlackNotifications === undefined
        ? {}
        : { forumPostSlackNotifications: parsed.data.forumPostSlackNotifications })
    },
    select: selection()
  });
  console.log("[comment-notify] settings updated", {
    userId: user.id,
    ...updated,
    documentCommentPreference: preference ?? null
  });
  return NextResponse.json({
    ...updated,
    commentNotificationScope: userDefaultCommentScope(updated)
  });
}
