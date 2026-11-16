import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAccessRequest } from "@/lib/access-requests";
import { notifyAccessGranted } from "@/lib/activity-notifications";
import type { RouteContext } from "@/lib/api-helpers";
import { getCurrentUser } from "@/lib/auth";
import { permissionLevels } from "@/lib/contracts";
import { db } from "@/lib/db";

const resolveSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("grant"), permission: z.enum(permissionLevels) }),
  z.object({ action: z.literal("decline") })
]);

// The owner grants (→ collaborator with the chosen permission) or declines.
export async function PATCH(request: Request, { params }: RouteContext<{ id: string; requestId: string }>) {
  const { id, requestId } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const parsed = resolveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid access decision." }, { status: 400 });
  }
  const document = await db.document.findUnique({ where: { id }, select: { ownerId: true } });
  if (!document || document.ownerId !== user.id) {
    return NextResponse.json({ error: "Only the owner can answer access requests." }, { status: 403 });
  }
  const resolution = await resolveAccessRequest({
    documentId: id,
    requestId,
    action: parsed.data.action,
    permission: parsed.data.action === "grant" ? parsed.data.permission : undefined
  });
  if (resolution.status === "not-found") {
    return NextResponse.json({ error: "That request was already answered." }, { status: 404 });
  }
  console.log("[access-request] resolved", { documentId: id, requestId, action: parsed.data.action, by: user.id });
  if (resolution.status === "granted") {
    void notifyAccessGranted({
      documentId: id,
      requesterUserId: resolution.requesterId,
      grantedByLabel: user.name
    });
    return NextResponse.json({ status: "granted", membership: resolution.membership });
  }
  return NextResponse.json({ status: "declined" });
}
