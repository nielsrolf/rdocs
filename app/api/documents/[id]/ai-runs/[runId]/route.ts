import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { cancelAiRun } from "@/lib/agent-runner/run-registry";
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
      selectedText: true,
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
  // Unlike the fields above, agentComments is NOT gated on success: comments
  // the agent leaves mid-run via add_comment already exist as threads, and the
  // client anchors each one as soon as it appears.
  const agentComments = parseJsonArray<{ threadId: string; findText: string }>(run.agentComments);

  return NextResponse.json({
    aiRun: {
      id: run.id,
      documentId: run.documentId,
      triggerType: run.triggerType,
      triggerId: run.triggerId,
      selectionId: run.selectionId,
      selectedText: run.selectedText,
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

  if (action !== "markApplied" && action !== "cancel") {
    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  }

  const user = await getCurrentUser();
  const access = await resolveDocumentAccess(
    id,
    user?.id,
    typeof shareToken === "string" ? shareToken : null
  );

  if (action === "cancel") {
    // Anyone who can start agent runs (comment access) may stop one.
    if (!access || !canComment(access.permission)) {
      return NextResponse.json({ error: "You do not have agent access." }, { status: 403 });
    }
    const target = await db.aiRun.findFirst({
      where: { id: runId, documentId: id },
      select: { status: true }
    });
    if (!target) {
      return NextResponse.json({ error: "Run not found." }, { status: 404 });
    }
    if (target.status !== "RUNNING") {
      return NextResponse.json({ ok: true, cancelled: false, status: target.status });
    }
    const cancelled = cancelAiRun(runId);
    if (!cancelled) {
      // RUNNING in the DB but not owned by this process — a restart orphan the
      // reaper/boot sweep will fail shortly; nothing to abort here.
      return NextResponse.json(
        { error: "This run is not owned by the current server process; it will be reaped shortly." },
        { status: 409 }
      );
    }
    // Bookkeeping (status FAILED + "Cancelled by user." + workspace preservation)
    // happens in the background runner's catch; the client sees it via polling.
    return NextResponse.json({ ok: true, cancelled: true }, { status: 202 });
  }
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
