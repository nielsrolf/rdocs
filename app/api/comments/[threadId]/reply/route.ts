import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { broadcastDocumentEvent } from "@/lib/collaboration";
import { serializeComment } from "@/lib/document-data";
import { db } from "@/lib/db";
import { notifyCommentPosted } from "@/lib/comment-notifications";
import { syncCommentMentions } from "@/lib/mention-data";
import { canCommentOnDocument } from "@/lib/permissions";

const createReplySchema = z.object({
  body: z.string().min(1).max(4000),
  // Forum-view nesting: reply to a specific comment in this thread. Studio
  // rendering stays flat and simply ignores it.
  parentId: z.string().min(1).max(100).optional().nullable(),
  clientId: z.string().min(1).max(120).optional().nullable(),
  shareToken: z.string().optional().nullable(),
  // Display name for anonymous share-link commenters; ignored when signed in.
  guestName: z.string().trim().min(1).max(80).optional().nullable()
});

export async function POST(request: Request, { params }: RouteContext<{ threadId: string }>) {
  const startedAt = Date.now();
  const { threadId } = await params;

  const body = await request.json().catch(() => null);
  const parsed = createReplySchema.safeParse(body);
  if (!parsed.success) {
    console.warn("[comment-reply] invalid payload", { threadId, issues: parsed.error.issues.map((i) => i.path.join(".") + ":" + i.code) });
    return NextResponse.json({ error: "Invalid reply payload." }, { status: 400 });
  }

  const thread = await db.commentThread.findUnique({
    where: { id: threadId },
    select: {
      documentId: true
    }
  });

  if (!thread) {
    console.warn("[comment-reply] thread not found", { threadId });
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  // Anonymous share-link visitors may reply too — access is resolved from the
  // share token, mirroring the thread-create route.
  const gate = await requireDocumentAccess(request, thread.documentId, "VIEW", {
    shareToken: parsed.data.shareToken ?? null
  });
  if (!gate.ok) {
    console.warn("[comment-reply] forbidden", { threadId, documentId: thread.documentId, status: gate.response.status });
    return gate.response;
  }
  const { user, access } = gate;
  if (!canCommentOnDocument(access, Boolean(user))) {
    console.warn("[comment-reply] forbidden", { threadId, documentId: thread.documentId, userId: user?.id ?? null, permission: access.permission });
    return jsonError(403, "You do not have comment access.");
  }

  // A nesting parent must be a comment of THIS thread; a bogus id degrades to
  // a flat reply rather than failing the whole comment.
  let parentId: string | null = null;
  if (parsed.data.parentId) {
    const parent = await db.comment.findUnique({
      where: { id: parsed.data.parentId },
      select: { threadId: true }
    });
    if (parent?.threadId === threadId) {
      parentId = parsed.data.parentId;
    }
  }

  const comment = await db.comment.create({
    data: {
      threadId,
      parentId,
      body: parsed.data.body,
      authorId: user?.id ?? null,
      guestName: user ? null : parsed.data.guestName?.trim() || "Guest"
    },
    select: {
      id: true,
      body: true,
      aiModel: true,
      guestName: true,
      sourceLinks: true,
      commitSha: true,
      commitUrl: true,
      aiRunId: true,
      createdAt: true,
      author: {
        select: {
          id: true,
          name: true
        }
      }
    }
  });

  const now = new Date();
  await db.commentThread.update({
    where: { id: threadId },
    data: {
      updatedAt: now
    }
  });
  // Read markers are per-user; anonymous visitors have no user row to track.
  if (user) {
    await db.commentThreadRead.upsert({
      where: { threadId_userId: { threadId, userId: user.id } },
      create: { threadId, userId: user.id, lastReadAt: now },
      update: { lastReadAt: now }
    });
  }

  await syncCommentMentions({
    commentId: comment.id,
    documentId: thread.documentId,
    body: parsed.data.body,
    authorId: user?.id ?? null
  });

  const serialized = serializeComment(comment);
  broadcastDocumentEvent(
    thread.documentId,
    "comment-created",
    { threadId, comment: serialized },
    parsed.data.clientId ?? null
  );

  // Slack DM notifications — fire-and-forget after the write is committed.
  void notifyCommentPosted({
    threadId,
    documentId: thread.documentId,
    commentBody: parsed.data.body,
    authorLabel: user?.name ?? comment.guestName ?? "Guest",
    excludeUserIds: [user?.id]
  });

  console.log("[comment-reply]", {
    threadId,
    documentId: thread.documentId,
    userId: user?.id ?? null,
    guest: !user,
    commentId: comment.id,
    bodyBytes: parsed.data.body.length,
    elapsedMs: Date.now() - startedAt
  });

  return NextResponse.json({ comment: serialized, lastReadAt: user ? now : null });
}
