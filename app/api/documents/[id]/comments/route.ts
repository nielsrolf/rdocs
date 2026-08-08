import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { broadcastDocumentEvent } from "@/lib/collaboration";
import { documentHasAnchorForThread, parseDocumentContent } from "@/lib/content";
import { serializeThread } from "@/lib/document-data";
import { db } from "@/lib/db";
import { syncCommentMentions } from "@/lib/mention-data";
import { canCommentOnDocument } from "@/lib/permissions";

const createThreadSchema = z.object({
  threadId: z.string().min(1).max(100).optional(),
  body: z.string().min(1).max(4000),
  // "studio" (default) threads anchor to document text; "forum" threads are
  // top-level forum comments with no anchor.
  origin: z.enum(["studio", "forum"]).optional(),
  anchorText: z.string().max(1000).optional().default(""),
  anchorContext: z.string().max(2000).optional().nullable(),
  clientId: z.string().min(1).max(120).optional().nullable(),
  shareToken: z.string().optional().nullable(),
  // Display name for anonymous share-link commenters; ignored when signed in.
  guestName: z.string().trim().min(1).max(80).optional().nullable()
});

export async function POST(request: Request, { params }: RouteContext<{ id: string }>) {
  const startedAt = Date.now();
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const parsed = createThreadSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message
    }));
    console.warn("[comment-create] invalid payload", { documentId: id, issues });
    return NextResponse.json({ error: "Invalid comment payload.", issues }, { status: 400 });
  }

  // Anonymous share-link visitors may comment too — access is resolved from
  // the share token, mirroring the collab and ai-edit routes. Forum-public
  // documents accept comments from any signed-in user (canCommentOnDocument).
  const gate = await requireDocumentAccess(request, id, "VIEW", {
    shareToken: parsed.data.shareToken ?? null
  });
  if (!gate.ok) {
    console.warn("[comment-create] no access", { documentId: id, status: gate.response.status });
    return gate.response;
  }
  const { user, access } = gate;
  if (!canCommentOnDocument(access, Boolean(user))) {
    console.warn("[comment-create] forbidden", { documentId: id, userId: user?.id ?? null, permission: access.permission });
    return jsonError(403, "You do not have comment access.");
  }

  const guestName = user ? null : parsed.data.guestName?.trim() || "Guest";
  const origin = parsed.data.origin ?? "studio";

  // Studio threads must arrive with a real anchor snippet; forum threads
  // deliberately have none.
  if (origin === "studio" && parsed.data.anchorText.length === 0) {
    console.warn("[comment-create] missing anchorText", { documentId: id, userId: user?.id ?? null });
    return NextResponse.json({ error: "Invalid comment payload." }, { status: 400 });
  }

  // Refuse to create an orphan: the client is expected to push the
  // commentAnchor step before POSTing the thread. If the anchor isn't on the
  // server's current doc yet, the client must wait for its collab flush to
  // succeed and retry. Without this, a transient "Save failed" between the
  // step push and this POST leaves a thread row with no anchor mark and the
  // comment becomes invisible in the editor.
  if (parsed.data.threadId && origin === "studio") {
    const docContent = parseDocumentContent(access.document.content);
    if (!documentHasAnchorForThread(docContent, parsed.data.threadId)) {
      console.warn("[comment-create] anchor missing", {
        documentId: id,
        userId: user?.id ?? null,
        threadId: parsed.data.threadId
      });
      return NextResponse.json(
        { error: "Anchor not yet saved. Please retry in a moment." },
        { status: 409 }
      );
    }
  }

  try {
  const thread = await db.commentThread.create({
    data: {
      id: parsed.data.threadId,
      documentId: id,
      createdById: user?.id ?? null,
      origin,
      anchorText: parsed.data.anchorText,
      anchorContext: parsed.data.anchorContext,
      comments: {
        create: {
          body: parsed.data.body,
          authorId: user?.id ?? null,
          guestName
        }
      }
    },
    select: {
      id: true,
      anchorText: true,
      anchorContext: true,
      status: true,
      tags: true,
      createdAt: true,
      createdBy: {
        select: {
          id: true,
          name: true
        }
      },
      comments: {
        orderBy: {
          createdAt: "asc"
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
      }
    }
  });

  const now = new Date();
  // Read markers are per-user; anonymous visitors have no user row to track.
  if (user) {
    await db.commentThreadRead.upsert({
      where: { threadId_userId: { threadId: thread.id, userId: user.id } },
      create: { threadId: thread.id, userId: user.id, lastReadAt: now },
      update: { lastReadAt: now }
    });
  }

  const firstComment = thread.comments[0];
  if (firstComment) {
    await syncCommentMentions({
      commentId: firstComment.id,
      documentId: id,
      body: parsed.data.body,
      authorId: user?.id ?? null
    });
  }

  const updated = await db.document.findUnique({
    where: { id },
    select: {
      updatedAt: true
    }
  });

    const serialized = serializeThread(thread, { lastReadAt: user ? now : null });
    broadcastDocumentEvent(
      id,
      "thread-created",
      { thread: serialized, updatedAt: updated?.updatedAt ?? null },
      parsed.data.clientId ?? null
    );

    console.log("[comment-create]", {
      documentId: id,
      userId: user?.id ?? null,
      guest: !user,
      threadId: thread.id,
      anchorBytes: parsed.data.anchorText.length,
      bodyBytes: parsed.data.body.length,
      elapsedMs: Date.now() - startedAt
    });

    return NextResponse.json({
      thread: serialized,
      updatedAt: updated?.updatedAt ?? null
    });
  } catch (error) {
    console.error("[comment-create] failed", {
      documentId: id,
      userId: user?.id ?? null,
      requestedThreadId: parsed.data.threadId ?? null,
      bodyBytes: parsed.data.body.length,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : error
    });
    return NextResponse.json({ error: "Failed to save comment." }, { status: 500 });
  }
}
