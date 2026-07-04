import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { canComment, canEdit, resolveDocumentAccess } from "@/lib/permissions";

type RouteContext = {
  params: Promise<{
    id: string;
    runId: string;
  }>;
};

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function GET(request: Request, { params }: RouteContext) {
  const { id, runId } = await params;
  const url = new URL(request.url);
  const shareToken = url.searchParams.get("share");
  const user = await getCurrentUser();

  const access = await resolveDocumentAccess(id, user?.id, shareToken);
  if (!access) {
    return NextResponse.json({ error: "You do not have access to this run." }, { status: 403 });
  }

  const run = await db.aiRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      documentId: true,
      triggerType: true,
      triggerId: true,
      selectionId: true,
      instruction: true,
      status: true,
      progress: true,
      model: true,
      commitSha: true,
      commitUrl: true,
      error: true,
      startedAt: true,
      finishedAt: true,
      appliedAt: true,
      replacementText: true,
      replacementImages: true,
      replacementWidgets: true,
      replacementSources: true,
      suggestions: true,
      agentComments: true,
      suggestOnly: true
    }
  });

  if (!run || run.documentId !== id) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  // Only expose replacement payload after success so clients don't apply partial state.
  const isSucceeded = run.status === "SUCCEEDED";
  const replacementText = isSucceeded ? run.replacementText : null;
  const images = isSucceeded ? parseJsonArray<Record<string, unknown>>(run.replacementImages) : [];
  const widgets = isSucceeded ? parseJsonArray<Record<string, unknown>>(run.replacementWidgets) : [];
  const sources = isSucceeded ? parseJsonArray<string>(run.replacementSources) : [];
  const suggestions = isSucceeded ? parseJsonArray<Record<string, unknown>>(run.suggestions) : [];
  const agentComments = isSucceeded
    ? parseJsonArray<{ threadId: string; findText: string }>(run.agentComments)
    : [];

  return NextResponse.json({
    aiRun: {
      id: run.id,
      documentId: run.documentId,
      triggerType: run.triggerType,
      triggerId: run.triggerId,
      selectionId: run.selectionId,
      instruction: run.instruction,
      status: run.status,
      progress: run.progress,
      model: run.model,
      commitSha: run.commitSha,
      commitUrl: run.commitUrl,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      appliedAt: run.appliedAt,
      replacementText,
      images,
      widgets,
      sources,
      suggestions,
      agentComments,
      suggestOnly: run.suggestOnly
    }
  });
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id, runId } = await params;
  const body = await request.json().catch(() => null);
  const action = body && typeof body === "object" ? (body as { action?: unknown }).action : null;
  const shareToken =
    body && typeof body === "object"
      ? (body as { shareToken?: unknown }).shareToken
      : null;

  if (action !== "markApplied") {
    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  }

  const user = await getCurrentUser();
  const access = await resolveDocumentAccess(
    id,
    user?.id,
    typeof shareToken === "string" ? shareToken : null
  );
  // Suggest-only runs land as tracked changes (not committed content), so a
  // comment-access user is allowed to mark them applied; committed edits remain
  // edit-only.
  const run = await db.aiRun.findFirst({
    where: { id: runId, documentId: id },
    select: { suggestOnly: true }
  });
  const allowed = Boolean(access) && (canEdit(access!.permission) || (run?.suggestOnly === true && canComment(access!.permission)));
  if (!allowed) {
    return NextResponse.json({ error: "You do not have edit access." }, { status: 403 });
  }

  const updated = await db.aiRun.updateMany({
    where: { id: runId, documentId: id, appliedAt: null },
    data: { appliedAt: new Date() }
  });

  return NextResponse.json({ ok: true, claimed: updated.count > 0 });
}
