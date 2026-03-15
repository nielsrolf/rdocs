import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { runClaudeCommentReply } from "@/lib/ai";
import {
  getContextAroundMatch,
  getDocumentAiBlocks,
  getDocumentPlainText,
  parseDocumentContent
} from "@/lib/content";
import { db } from "@/lib/db";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";

export const runtime = "nodejs";

const askAiSchema = z.object({
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    threadId: string;
  }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const { threadId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "You must be signed in to ask AI." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = askAiSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid AI request payload." }, { status: 400 });
  }

  const thread = await db.commentThread.findUnique({
    where: { id: threadId },
    select: {
      id: true,
      anchorText: true,
      anchorContext: true,
      documentId: true,
      document: {
        select: {
          title: true,
          content: true
        }
      },
      comments: {
        orderBy: {
          createdAt: "asc"
        },
        select: {
          body: true,
          author: {
            select: {
              name: true
            }
          },
          aiModel: true
        }
      }
    }
  });

  if (!thread) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  const access = await resolveDocumentAccess(
    thread.documentId,
    user.id,
    parsed.data.shareToken ?? null
  );
  if (!access || !canComment(access.permission)) {
    return NextResponse.json({ error: "You do not have comment access." }, { status: 403 });
  }

  try {
    const documentContent = parseDocumentContent(thread.document.content);
    const documentText = getDocumentPlainText(documentContent);
    const documentBlocks = getDocumentAiBlocks(documentContent);
    const derivedAnchorContext =
      thread.anchorContext || getContextAroundMatch(documentText, thread.anchorText);

    const aiReply = await runClaudeCommentReply({
      documentTitle: thread.document.title,
      documentText,
      documentBlocks,
      anchorText: thread.anchorText,
      anchorContext: derivedAnchorContext,
      requesterName: user.name,
      comments: thread.comments.map((comment) => ({
        author: comment.author?.name ?? comment.aiModel ?? "Claude",
        body: comment.body
      }))
    });

    const comment = await db.comment.create({
      data: {
        threadId: thread.id,
        body: aiReply.reply,
        aiModel: aiReply.model
      },
      select: {
        id: true,
        body: true,
        aiModel: true,
        createdAt: true,
        author: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    await db.commentThread.update({
      where: { id: thread.id },
      data: {
        updatedAt: new Date()
      }
    });

    return NextResponse.json({ comment });
  } catch (error) {
    console.error("ask-ai failed", {
      threadId: thread.id,
      error: error instanceof Error ? error.message : error
    });

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The AI helper failed before producing a reply."
      },
      { status: 500 }
    );
  }
}
