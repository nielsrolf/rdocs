import { NextResponse } from "next/server";

import { jsonError, requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { cancelAiRun } from "@/lib/agent-runner/run-registry";
import { db } from "@/lib/db";
import { canComment, canEdit } from "@/lib/permissions";

// Safety cap on the lazy-loaded full timeline — orders of magnitude above the
// poll's per-run window, small enough to bound a pathological run's payload.
const AI_RUN_DETAIL_EVENT_CAP = 5000;

type RunRouteParams = { id: string; runId: string };

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function GET(request: Request, { params }: RouteContext<RunRouteParams>) {
  const { id, runId } = await params;
  const gate = await requireDocumentAccess(request, id, "VIEW");
  if (!gate.ok) {
    return gate.response;
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
      suggestOnly: true,
      // Persisted application outputs are the source of truth for the result
      // view. In particular, comment-reply runs historically stored only the
      // model's short summary in AiRunEvent; the actual reply lives here.
      comments: {
        orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
        select: {
          id: true,
          threadId: true,
          body: true,
          createdAt: true,
          thread: { select: { anchorText: true } }
        }
      },
      // FULL timeline for this run (generous safety cap, far above any real
      // run). The polled document list only ships a small tail window per run
      // (`eventsClipped`) and omits events on older runs (`eventsOmitted`);
      // the agent panel lazy-loads complete timelines from here, so this
      // route must not apply the poll's per-run window.
      events: {
        orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
        take: AI_RUN_DETAIL_EVENT_CAP,
        select: {
          id: true,
          role: true,
          message: true,
          createdAt: true
        }
      }
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
      comments: run.comments.map((comment) => ({
        id: comment.id,
        threadId: comment.threadId,
        anchorText: comment.thread.anchorText,
        body: comment.body,
        createdAt: comment.createdAt
      })),
      suggestOnly: run.suggestOnly,
      // Flipped back to chronological order for rendering.
      events: [...run.events].reverse()
    }
  });
}

export async function POST(request: Request, { params }: RouteContext<RunRouteParams>) {
  const { id, runId } = await params;
  const body = await request.json().catch(() => null);
  const action = body && typeof body === "object" ? (body as { action?: unknown }).action : null;

  if (action !== "markApplied" && action !== "cancel") {
    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  }

  const gate = await requireDocumentAccess(request, id, "VIEW", { body });
  if (!gate.ok) {
    return gate.response;
  }
  const { access } = gate;

  if (action === "cancel") {
    // Anyone who can start agent runs (comment access) may stop one.
    if (!canComment(access.permission)) {
      return jsonError(403, "You do not have agent access.");
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
  const allowed = canEdit(access.permission) || (run?.suggestOnly === true && canComment(access.permission));
  if (!allowed) {
    return jsonError(403, "You do not have edit access.");
  }

  const updated = await db.aiRun.updateMany({
    where: { id: runId, documentId: id, appliedAt: null },
    data: { appliedAt: new Date() }
  });

  return NextResponse.json({ ok: true, claimed: updated.count > 0 });
}
