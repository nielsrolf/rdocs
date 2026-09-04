import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  FORUM_LAYOUT_COOKIE,
  FORUM_LAYOUT_COOKIE_MAX_AGE_SECONDS,
  FORUM_LAYOUTS
} from "@/lib/forum-layout";

const patchSchema = z.object({ layout: z.enum(FORUM_LAYOUTS) });

// Sets the forum frontpage layout. Works signed-out (cookie only) and
// signed-in (cookie + User.forumLayout so the choice follows the account).
export async function PATCH(request: Request) {
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid layout." }, { status: 400 });
  }
  const layout = parsed.data.layout;
  const user = await getCurrentUser();
  if (user) {
    await db.user.update({ where: { id: user.id }, data: { forumLayout: layout } });
    console.log("[forum] layout updated", { userId: user.id, layout });
  }
  const response = NextResponse.json({ layout });
  response.cookies.set(FORUM_LAYOUT_COOKIE, layout, {
    path: "/",
    maxAge: FORUM_LAYOUT_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    httpOnly: false
  });
  return response;
}
