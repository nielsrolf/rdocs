import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { serializeAiRun } from "@/lib/ai-runs";
import { listDocumentThreads, maybeCreateVersionSnapshot } from "@/lib/document-data";
import { parseDocumentContent, serializeDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";
import { normalizeSourceLinks } from "@/lib/sources";

const updateDocumentSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.unknown().optional(),
  shareToken: z.string().optional().nullable(),
  forceVersion: z.boolean().optional(),
  sourceLinks: z.array(z.string().url()).optional(),
  commitSha: z.string().optional().nullable(),
  commitUrl: z.string().url().optional().nullable(),
  aiRunId: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function PATCH(request: Request, { params }: RouteContext) {
  const startedAt = Date.now();
  const { id } = await params;
  const user = await getCurrentUser();
  const body = await request.json().catch(() => null);
  const parsed = updateDocumentSchema.safeParse(body);

  if (!parsed.success) {
    console.warn("[doc-patch] invalid payload", {
      documentId: id,
      userId: user?.id ?? null,
      issues: parsed.error.issues.map((issue) => issue.path.join(".") + ":" + issue.code)
    });
    return NextResponse.json({ error: "Invalid document update payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user?.id, parsed.data.shareToken ?? null);
  if (!access || !canEdit(access.permission)) {
    console.warn("[doc-patch] forbidden", {
      documentId: id,
      userId: user?.id ?? null,
      hasAccess: !!access,
      permission: access?.permission ?? null
    });
    return NextResponse.json({ error: "You do not have edit access." }, { status: 403 });
  }

  const nextTitle = parsed.data.title.trim();
  const hasContentUpdate = parsed.data.content !== undefined;
  const nextContent = hasContentUpdate
    ? serializeDocumentContent(parsed.data.content)
    : access.document.content;
  const titleChanged = nextTitle !== access.document.title;
  const contentChanged = hasContentUpdate && nextContent !== access.document.content;

  // Document content is now persisted exclusively through the collaboration
  // step pipeline (POST /collaboration). A direct content write here bypasses
  // the step log and the in-memory room, desyncing every connected client — the
  // historical root cause of post-AI-edit divergence. No client should send
  // `content` to this route anymore; warn loudly if one does so we can find it.
  if (hasContentUpdate) {
    console.warn("[doc-patch] direct content write bypasses collaboration pipeline", {
      documentId: id,
      userId: user?.id ?? null,
      contentChanged
    });
  }

  try {
    if (hasContentUpdate || titleChanged || parsed.data.forceVersion) {
      await maybeCreateVersionSnapshot({
        documentId: id,
        currentTitle: access.document.title,
        currentContent: access.document.content,
        nextTitle,
        nextContent,
        force: parsed.data.forceVersion,
        sourceLinks: normalizeSourceLinks(parsed.data.sourceLinks ?? []),
        commitSha: parsed.data.commitSha ?? null,
        commitUrl: parsed.data.commitUrl ?? null,
        aiRunId: parsed.data.aiRunId ?? null
      });
    }

    const updated = await db.document.update({
      where: { id },
      data: {
        title: nextTitle,
        ...(hasContentUpdate ? { content: nextContent } : {})
      },
      select: {
        updatedAt: true
      }
    });

    console.log("[doc-patch]", {
      documentId: id,
      userId: user?.id ?? null,
      titleChanged,
      contentChanged,
      hasContentUpdate,
      previousBytes: access.document.content.length,
      nextBytes: nextContent.length,
      forceVersion: parsed.data.forceVersion ?? false,
      aiRunId: parsed.data.aiRunId ?? null,
      commitSha: parsed.data.commitSha ?? null,
      elapsedMs: Date.now() - startedAt
    });

    return NextResponse.json({ ok: true, updatedAt: updated.updatedAt });
  } catch (error) {
    console.error("[doc-patch] failed", {
      documentId: id,
      userId: user?.id ?? null,
      titleChanged,
      contentChanged,
      previousBytes: access.document.content.length,
      nextBytes: nextContent.length,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : error
    });
    return NextResponse.json({ error: "Failed to save document." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const document = await db.document.findUnique({ where: { id }, select: { ownerId: true } });
  if (!document) {
    console.warn("[doc-delete] not found", { documentId: id, userId: user.id });
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  if (document.ownerId !== user.id) {
    console.warn("[doc-delete] forbidden", { documentId: id, userId: user.id, ownerId: document.ownerId });
    return NextResponse.json({ error: "Only the owner can delete this document." }, { status: 403 });
  }

  await db.document.delete({ where: { id } });
  console.log("[doc-delete]", { documentId: id, userId: user.id });
  return NextResponse.json({ ok: true });
}

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const shareToken = new URL(request.url).searchParams.get("share");
  const access = await resolveDocumentAccess(id, user?.id, shareToken);

  if (!access) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const [threads, aiRuns] = await Promise.all([
    listDocumentThreads(id, user?.id ?? null),
    db.aiRun.findMany({
      where: { documentId: id },
      orderBy: { startedAt: "desc" },
      take: 12,
      select: {
        id: true,
        triggerType: true,
        triggerId: true,
        selectionId: true,
        parentRunId: true,
        instruction: true,
        status: true,
        progress: true,
        model: true,
        workspacePath: true,
        branchName: true,
        commitSha: true,
        commitUrl: true,
        error: true,
        startedAt: true,
        finishedAt: true,
        appliedAt: true,
        events: {
          orderBy: { createdAt: "asc" },
          take: 80,
          select: {
            id: true,
            role: true,
            message: true,
            createdAt: true
          }
        }
      }
    })
  ]);

  // In-process agents abort after 10 min and the route updates status accordingly.
  // A RUNNING run older than that is guaranteed abandoned (server restart/crash).
  const STALE_RUN_MS = 12 * 60 * 1000;
  const now = Date.now();
  const staleRunIds = aiRuns
    .filter((run) => run.status === "RUNNING" && now - run.startedAt.getTime() > STALE_RUN_MS)
    .map((run) => run.id);
  if (staleRunIds.length > 0) {
    const finishedAt = new Date();
    const error = "Run abandoned (server restart or crash).";
    await db.aiRun.updateMany({
      where: { id: { in: staleRunIds }, status: "RUNNING" },
      data: { status: "FAILED", error, finishedAt }
    });
    const staleSet = new Set(staleRunIds);
    for (const run of aiRuns) {
      if (staleSet.has(run.id)) {
        run.status = "FAILED";
        run.error = error;
        run.finishedAt = finishedAt;
      }
    }
  }

  const activeAiRuns = aiRuns.filter((run) => run.status === "RUNNING");

  return NextResponse.json({
    document: {
      id: access.document.id,
      title: access.document.title,
      content: parseDocumentContent(access.document.content),
      repoUrl: access.document.repoUrl,
      repoBranch: access.document.repoBranch,
      updatedAt: access.document.updatedAt
    },
    threads,
    activeAiRun: activeAiRuns[0] ? serializeAiRun(activeAiRuns[0]) : null,
    activeAiRuns: activeAiRuns.map(serializeAiRun),
    aiRuns: aiRuns.map(serializeAiRun)
  });
}
