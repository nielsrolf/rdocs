import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { addCommentAnchorToContent, differsOnlyByCommentAnchors } from "@/lib/comment-anchors";
import { parseDocumentContent, serializeDocumentContent } from "@/lib/content";
import { serializeThread } from "@/lib/document-data";
import { db } from "@/lib/db";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";

const createThreadSchema = z.object({
  threadId: z.string().min(1).max(100).optional(),
  body: z.string().min(1).max(4000),
  anchorText: z.string().min(1).max(1000),
  anchorContext: z.string().max(2000).optional().nullable(),
  fromPos: z.number().int().optional().nullable(),
  toPos: z.number().int().optional().nullable(),
  content: z.unknown().optional(),
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "You must be signed in to comment." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = createThreadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid comment payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user.id, parsed.data.shareToken ?? null);
  if (!access || !canComment(access.permission)) {
    return NextResponse.json({ error: "You do not have comment access." }, { status: 403 });
  }

  const currentContent = parseDocumentContent(access.document.content);
  let nextContent: string | null = null;
  if (
    typeof parsed.data.fromPos === "number" &&
    typeof parsed.data.toPos === "number" &&
    parsed.data.threadId
  ) {
    const anchoredContent = addCommentAnchorToContent(
      currentContent,
      parsed.data.fromPos,
      parsed.data.toPos,
      parsed.data.threadId
    );
    nextContent = anchoredContent ? serializeDocumentContent(anchoredContent) : null;
  }

  if (nextContent == null && parsed.data.content !== undefined) {
    if (!differsOnlyByCommentAnchors(currentContent, parsed.data.content)) {
      return NextResponse.json(
        {
          error:
            "Comment anchor positions no longer match the saved document. Save or refresh the document and try again."
        },
        { status: 409 }
      );
    }
    nextContent = serializeDocumentContent(parsed.data.content);
  }

  const thread = await db.$transaction(async (tx) => {
    const createdThread = await tx.commentThread.create({
      data: {
        id: parsed.data.threadId,
        documentId: id,
        createdById: user.id,
        anchorText: parsed.data.anchorText,
        anchorContext: parsed.data.anchorContext,
        fromPos: parsed.data.fromPos,
        toPos: parsed.data.toPos,
        comments: {
          create: {
            body: parsed.data.body,
            authorId: user.id
          }
        }
      },
      select: {
        id: true,
        anchorText: true,
        anchorContext: true,
        fromPos: true,
        toPos: true,
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

    if (nextContent != null) {
      await tx.document.update({
        where: { id },
        data: { content: nextContent }
      });
    }

    return createdThread;
  });

  const updated = await db.document.findUnique({
    where: { id },
    select: {
      updatedAt: true
    }
  });

  return NextResponse.json({
    thread: serializeThread(thread),
    updatedAt: updated?.updatedAt ?? null
  });
}
