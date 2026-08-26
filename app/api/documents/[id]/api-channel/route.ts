import { NextResponse } from "next/server";
import { z } from "zod";

import { upsertAgentApiChannel, revokeAgentApiChannel } from "@/lib/agent-api-channels";
import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";

export const runtime = "nodejs";

const createSchema = z.object({ label: z.string().max(120).optional().nullable() });

export async function POST(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid channel payload." }, { status: 400 });

  const gate = await requireDocumentAccess(request, id, "EDIT", {
    requireUser: true,
    forbiddenMessage: "Sign in as the document owner to create an API channel."
  });
  if (!gate.ok) return gate.response;
  if (gate.access.document.ownerId !== gate.user!.id) {
    return NextResponse.json({ error: "Only the document owner can create an API channel." }, { status: 403 });
  }

  const result = await upsertAgentApiChannel({
    documentId: id,
    createdById: gate.user!.id,
    label: parsed.data.label
  });
  return NextResponse.json({
    triggerId: result.channel.id,
    token: result.token,
    endpoint: `/api/agent-channels/${result.channel.id}/runs`
  }, { status: 201 });
}

export async function DELETE(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const gate = await requireDocumentAccess(request, id, "EDIT", {
    requireUser: true,
    forbiddenMessage: "Sign in as the document owner to revoke an API channel."
  });
  if (!gate.ok) return gate.response;
  if (gate.access.document.ownerId !== gate.user!.id) {
    return NextResponse.json({ error: "Only the document owner can revoke an API channel." }, { status: 403 });
  }
  const revoked = await revokeAgentApiChannel(id, gate.user!.id);
  return revoked
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "No active API channel." }, { status: 404 });
}
