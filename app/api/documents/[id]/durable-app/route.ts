import { NextResponse } from "next/server";
import { z } from "zod";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { configureDurableApp, DurableAppError, getDurableApp } from "@/lib/durable-apps";

export const runtime = "nodejs";

// Durable app settings (lib/durable-apps.ts). Reading needs edit access (it is
// part of the environment surface); changing anything is owner-only, enforced
// in configureDurableApp because it decides where every collaborator's runs
// execute and what gets published on the internet.
const patchSchema = z.object({
  enabled: z.boolean().optional(),
  hostname: z.string().trim().max(253).nullable().optional(),
  appPort: z.number().int().min(1).max(65535).optional(),
  innerDocker: z.boolean().optional()
});

async function requireAutomationAccess(request: Request, documentId: string) {
  return requireDocumentAccess(request, documentId, "EDIT", {
    shareToken: null,
    requireUser: true,
    forbiddenMessage: "You do not have edit access."
  });
}

function errorResponse(error: unknown) {
  if (error instanceof DurableAppError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("[durable-app] request failed", error);
  return NextResponse.json({ error: "Durable app request failed." }, { status: 500 });
}

export async function GET(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const auth = await requireAutomationAccess(request, id);
  if (!auth.ok) return auth.response;
  try {
    const app = await getDurableApp(id);
    return NextResponse.json({ app, isOwner: auth.access.document.ownerId === auth.user.id });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const auth = await requireAutomationAccess(request, id);
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid durable app payload." }, { status: 400 });
  }
  try {
    const app = await configureDurableApp(id, auth.user.id, parsed.data);
    return NextResponse.json({ app, isOwner: true });
  } catch (error) {
    return errorResponse(error);
  }
}
