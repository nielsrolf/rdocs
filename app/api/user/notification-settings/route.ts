import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

const patchSchema = z.object({
  // Slack DM notifications for new comments/replies on documents the user
  // owns or collaborates on (lib/comment-notifications.ts).
  commentSlackNotifications: z.boolean()
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const row = await db.user.findUnique({
    where: { id: user.id },
    select: { commentSlackNotifications: true }
  });
  return NextResponse.json({
    commentSlackNotifications: row?.commentSlackNotifications ?? true
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
  const updated = await db.user.update({
    where: { id: user.id },
    data: { commentSlackNotifications: parsed.data.commentSlackNotifications },
    select: { commentSlackNotifications: true }
  });
  console.log("[comment-notify] settings updated", {
    userId: user.id,
    commentSlackNotifications: updated.commentSlackNotifications
  });
  return NextResponse.json({
    commentSlackNotifications: updated.commentSlackNotifications
  });
}
