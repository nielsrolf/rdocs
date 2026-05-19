import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { normalizeThreadTags, serializeThread } from "@/lib/document-data";
import { db } from "@/lib/db";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";

const updateThreadSchema = z.object({
  tags: z.array(z.string().min(1).max(48)).max(20).optional(),
  status: z.enum(["OPEN", "RESOLVED"]).optional(),
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    threadId: string;
  }>;
};

export async function PATCH(request: Request, { params }: RouteContext) {
  const { threadId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "You must be signed in to update comments." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = updateThreadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid thread update payload." }, { status: 400 });
  }

  const existing = await db.commentThread.findUnique({
    where: { id: threadId },
    select: {
      documentId: true
    }
  });

  if (!existing) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  const access = await resolveDocumentAccess(existing.documentId, user.id, parsed.data.shareToken ?? null);
  if (!access || !canComment(access.permission)) {
    return NextResponse.json({ error: "You do not have comment access." }, { status: 403 });
  }

  const tags = normalizeThreadTags(parsed.data.tags ?? []);
  const hasResolvedTag = tags.some((tag) => tag.toLowerCase() === "resolved");
  const status = parsed.data.status ?? (hasResolvedTag ? "RESOLVED" : "OPEN");
  const nextTags =
    status === "RESOLVED" && !hasResolvedTag
      ? ["Resolved", ...tags]
      : status === "OPEN"
        ? tags.filter((tag) => tag.toLowerCase() !== "resolved")
        : tags;

  const thread = await db.commentThread.update({
    where: { id: threadId },
    data: {
      status,
      tags: JSON.stringify(nextTags)
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

  return NextResponse.json({ thread: serializeThread(thread) });
}
