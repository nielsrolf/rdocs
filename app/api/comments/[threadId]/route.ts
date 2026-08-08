import { NextResponse } from "next/server";
import { z } from "zod";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { broadcastDocumentEvent } from "@/lib/collaboration";
import { normalizeThreadTags, serializeThread } from "@/lib/document-data";
import { db } from "@/lib/db";

const updateThreadSchema = z.object({
  tags: z.array(z.string().min(1).max(48)).max(20).optional(),
  status: z.enum(["OPEN", "RESOLVED"]).optional(),
  clientId: z.string().min(1).max(120).optional().nullable(),
  shareToken: z.string().optional().nullable()
});

export async function PATCH(request: Request, { params }: RouteContext<{ threadId: string }>) {
  const startedAt = Date.now();
  const { threadId } = await params;

  const body = await request.json().catch(() => null);
  const parsed = updateThreadSchema.safeParse(body);
  if (!parsed.success) {
    console.warn("[thread-update] invalid payload", { threadId, issues: parsed.error.issues.map((i) => i.path.join(".") + ":" + i.code) });
    return NextResponse.json({ error: "Invalid thread update payload." }, { status: 400 });
  }

  const existing = await db.commentThread.findUnique({
    where: { id: threadId },
    select: {
      documentId: true
    }
  });

  if (!existing) {
    console.warn("[thread-update] not found", { threadId });
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  // Anonymous share-link visitors may resolve/tag threads too — access is
  // resolved from the share token, matching the create/reply routes.
  const gate = await requireDocumentAccess(request, existing.documentId, "COMMENT", {
    shareToken: parsed.data.shareToken ?? null,
    forbiddenMessage: "You do not have comment access."
  });
  if (!gate.ok) {
    console.warn("[thread-update] forbidden", { threadId, documentId: existing.documentId, status: gate.response.status });
    return gate.response;
  }
  const { user } = gate;

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

  const serialized = serializeThread(thread);
  broadcastDocumentEvent(
    existing.documentId,
    "thread-updated",
    { thread: serialized },
    parsed.data.clientId ?? null
  );

  console.log("[thread-update]", {
    threadId,
    documentId: existing.documentId,
    userId: user?.id ?? null,
    status,
    tagCount: nextTags.length,
    elapsedMs: Date.now() - startedAt
  });

  return NextResponse.json({ thread: serialized });
}
