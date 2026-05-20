import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { pullCollaborationSteps, submitCollaborationSteps } from "@/lib/collaboration";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";

const submitStepsSchema = z.object({
  version: z.number().int().nonnegative(),
  steps: z.array(z.unknown()).max(200),
  clientId: z.string().min(1).max(120),
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const url = new URL(request.url);
  const shareToken = url.searchParams.get("share");
  const version = Number.parseInt(url.searchParams.get("version") ?? "0", 10);

  if (!Number.isFinite(version) || version < 0) {
    return NextResponse.json({ error: "Invalid collaboration version." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user?.id, shareToken);
  if (!access) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  return NextResponse.json(
    await pullCollaborationSteps({
      documentId: id,
      rawContent: access.document.content,
      currentUpdatedAt: access.document.updatedAt,
      version
    })
  );
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const body = await request.json().catch(() => null);
  const parsed = submitStepsSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid collaboration step payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user?.id, parsed.data.shareToken ?? null);
  if (!access || !canEdit(access.permission)) {
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
      clientId: parsed.data.clientId
    });

    return NextResponse.json(result, {
      status: result.accepted ? 200 : 409
    });
  } catch (error) {
    console.error("collaboration step merge failed", {
      documentId: id,
      error: error instanceof Error ? error.message : error
    });
    return NextResponse.json({ error: "Unable to merge collaboration steps." }, { status: 409 });
  }
}
