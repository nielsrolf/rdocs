import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { pullCollaborationSteps, StepApplyError, submitCollaborationSteps } from "@/lib/collaboration";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";

const submitStepsSchema = z.object({
  version: z.number().int().nonnegative(),
  steps: z.array(z.unknown()).max(200),
  clientId: z.string().min(1).max(120),
  shareToken: z.string().optional().nullable(),
  // Optional version metadata for AI-edit pushes (attached to the snapshot the
  // push produces). Lets AI edits persist commit/source attribution without a
  // separate full-content PATCH that would desync the collaboration room.
  versionMeta: z
    .object({
      forceVersion: z.boolean().optional(),
      sourceLinks: z.array(z.string()).max(50).optional(),
      commitSha: z.string().max(200).optional().nullable(),
      commitUrl: z.string().max(2000).optional().nullable(),
      aiRunId: z.string().max(120).optional().nullable()
    })
    .optional()
});

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const startedAt = Date.now();
  const { id } = await params;
  const user = await getCurrentUser();
  const url = new URL(request.url);
  const shareToken = url.searchParams.get("share");
  const version = Number.parseInt(url.searchParams.get("version") ?? "0", 10);

  if (!Number.isFinite(version) || version < 0) {
    console.warn("[collab-pull] invalid version", { documentId: id, userId: user?.id ?? null, rawVersion: url.searchParams.get("version") });
    return NextResponse.json({ error: "Invalid collaboration version." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user?.id, shareToken);
  if (!access) {
    console.warn("[collab-pull] no access", { documentId: id, userId: user?.id ?? null, hasShareToken: !!shareToken });
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const payload = await pullCollaborationSteps({
    documentId: id,
    rawContent: access.document.content,
    currentUpdatedAt: access.document.updatedAt,
    version
  });

  console.log("[collab-pull] served", {
    documentId: id,
    userId: user?.id ?? null,
    fromVersion: version,
    durableVersion: payload.version,
    stepCount: Array.isArray(payload.steps) ? payload.steps.length : 0,
    elapsedMs: Date.now() - startedAt
  });

  return NextResponse.json(payload);
}

export async function POST(request: Request, { params }: RouteContext) {
  const startedAt = Date.now();
  const { id } = await params;
  const user = await getCurrentUser();
  const body = await request.json().catch(() => null);
  const parsed = submitStepsSchema.safeParse(body);

  if (!parsed.success) {
    console.warn("[collab-push] invalid payload", {
      documentId: id,
      userId: user?.id ?? null,
      issues: parsed.error.issues.map((issue) => issue.path.join(".") + ":" + issue.code)
    });
    return NextResponse.json({ error: "Invalid collaboration step payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user?.id, parsed.data.shareToken ?? null);
  if (!access || !canEdit(access.permission)) {
    console.warn("[collab-push] forbidden", {
      documentId: id,
      userId: user?.id ?? null,
      clientId: parsed.data.clientId,
      hasAccess: !!access,
      permission: access?.permission ?? null
    });
    return NextResponse.json({ error: "You do not have edit access." }, { status: 403 });
  }

  try {
    const result = await submitCollaborationSteps({
      documentId: id,
      rawContent: access.document.content,
      currentTitle: access.document.title,
      currentUpdatedAt: access.document.updatedAt,
      version: parsed.data.version,
      steps: parsed.data.steps,
      clientId: parsed.data.clientId,
      versionMeta: parsed.data.versionMeta
    });

    console.log("[collab-push]", {
      documentId: id,
      userId: user?.id ?? null,
      clientId: parsed.data.clientId,
      clientVersion: parsed.data.version,
      incomingSteps: parsed.data.steps.length,
      durableVersion: result.version,
      outcome: result.accepted ? "accepted" : "conflict",
      returnedSteps: Array.isArray(result.steps) ? result.steps.length : 0,
      status: result.accepted ? 200 : 409,
      elapsedMs: Date.now() - startedAt
    });

    return NextResponse.json(result, {
      status: result.accepted ? 200 : 409
    });
  } catch (error) {
    const applyFailed = error instanceof StepApplyError;
    console.error("[collab-push] step merge failed", {
      documentId: id,
      userId: user?.id ?? null,
      clientId: parsed.data.clientId,
      clientVersion: parsed.data.version,
      stepCount: parsed.data.steps.length,
      firstStepPreview: JSON.stringify(parsed.data.steps[0] ?? null).slice(0, 600),
      elapsedMs: Date.now() - startedAt,
      applyFailed,
      error: error instanceof Error ? error.message : error
    });
    // 422 = the steps themselves can't be applied (corrupt / schema mismatch).
    // Retrying the same steps will fail identically, so the client must NOT
    // treat this like a 409 conflict and re-flush. Any other error is a 500.
    if (applyFailed) {
      return NextResponse.json(
        { error: "Unable to apply collaboration steps.", code: "step-apply-failed" },
        { status: 422 }
      );
    }
    return NextResponse.json({ error: "Unable to merge collaboration steps." }, { status: 500 });
  }
}
