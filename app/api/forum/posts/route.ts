import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { notifyDocumentShared, notifyForumItemShared } from "@/lib/activity-notifications";
import { ForumPostingError, publishForumPost } from "@/lib/forum-posting";

const postSchema = z.object({
  documentId: z.string().min(1),
  audience: z.discriminatedUnion("type", [
    z.object({ type: z.literal("existing") }),
    z.object({ type: z.literal("public") }),
    z.object({ type: z.literal("group"), groupId: z.string().min(1) })
  ])
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid forum post payload." }, { status: 400 });
  }

  try {
    const result = await publishForumPost({ ...parsed.data, userId: user.id });
    console.log("[forum] created from forum", {
      documentId: parsed.data.documentId,
      userId: user.id,
      audience: parsed.data.audience.type
    });
    if (result.newlySharedUserIds.length > 0) {
      void notifyDocumentShared({
        documentId: parsed.data.documentId,
        recipientUserIds: result.newlySharedUserIds,
        sharedByLabel: user.name
      });
    }
    void notifyForumItemShared({
      documentId: parsed.data.documentId,
      sharedByLabel: user.name
    });
    return NextResponse.json({
      documentId: parsed.data.documentId,
      forumPostedAt: result.forumPostedAt,
      forumPublic: result.forumPublic
    });
  } catch (error) {
    if (error instanceof ForumPostingError) {
      const status = error.code === "not-editable" ? 403 : error.code === "group-not-found" ? 404 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    throw error;
  }
}
