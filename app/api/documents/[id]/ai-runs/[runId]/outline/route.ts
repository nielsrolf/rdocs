import { NextResponse } from "next/server";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { canComment } from "@/lib/permissions";
import { getRunOutline } from "@/lib/run-outline";

type RunRouteParams = { id: string; runId: string };

// The model-annotated outline of a run (lib/run-outline.ts). Answers at once:
// a missing or stale outline is generated in the background and reported as
// `pending`, so this never sits on a model call behind Cloudflare's 100s limit.
export async function GET(request: Request, { params }: RouteContext<RunRouteParams>) {
  const { id, runId } = await params;
  const gate = await requireDocumentAccess(request, id, "VIEW");
  if (!gate.ok) {
    return gate.response;
  }
  // Generating spends model calls on account credentials: only for signed-in
  // people who could start an agent run here. Everyone else reads what exists.
  const canGenerate = Boolean(gate.user) && canComment(gate.access.permission);
  const outline = await getRunOutline({ runId, documentId: id, userId: gate.user?.id ?? null, canGenerate });
  if (!outline) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }
  return NextResponse.json({ outline });
}
