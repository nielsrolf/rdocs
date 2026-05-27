import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { serializeThread } from "@/lib/document-data";
import { db } from "@/lib/db";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";

const createThreadSchema = z.object({
  threadId: z.string().min(1).max(100).optional(),
  body: z.string().min(1).max(4000),
  anchorText: z.string().min(1).max(1000),
  anchorContext: z.string().max(2000).optional().nullable(),
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
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message
    }));
    console.warn("[comments] invalid payload", { documentId: id, issues });
    return NextResponse.json({ error: "Invalid comment payload.", issues }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user.id, parsed.data.shareToken ?? null);
  if (!access || !canComment(access.permission)) {
    return NextResponse.json({ error: "You do not have comment access." }, { status: 403 });
  }

  const thread = await db.commentThread.create({
    data: {
      id: parsed.data.threadId,
      documentId: id,
      createdById: user.id,
      anchorText: parsed.data.anchorText,
      anchorContext: parsed.data.anchorContext,
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

  const now = new Date();
  await db.commentThreadRead.upsert({
    where: { threadId_userId: { threadId: thread.id, userId: user.id } },
    create: { threadId: thread.id, userId: user.id, lastReadAt: now },
    update: { lastReadAt: now }
  });

  const updated = await db.document.findUnique({
    where: { id },
    select: {
      updatedAt: true
    }
  });

  return NextResponse.json({
    thread: serializeThread(thread, { lastReadAt: now }),
    updatedAt: updated?.updatedAt ?? null
  });
}
