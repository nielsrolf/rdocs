import { NextResponse } from "next/server";
import { z } from "zod";

import {
  ACCESS_REQUEST_MESSAGE_MAX,
  listPendingAccessRequests,
  requestDocumentAccess
} from "@/lib/access-requests";
import { notifyAccessRequested } from "@/lib/activity-notifications";
import type { RouteContext } from "@/lib/api-helpers";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

const requestSchema = z.object({
  message: z.string().max(ACCESS_REQUEST_MESSAGE_MAX).nullable().optional()
});

// Pending requests, for the owner's Share dialog.
export async function GET(_request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const document = await db.document.findUnique({ where: { id }, select: { ownerId: true } });
  if (!document || document.ownerId !== user.id) {
    return NextResponse.json({ error: "Only the owner can see access requests." }, { status: 403 });
  }
  const requests = await listPendingAccessRequests(id);
  return NextResponse.json({
    requests: requests.map((request) => ({ ...request, createdAt: request.createdAt.toISOString() }))
  });
}

// "Ask for permission": any signed-in user WITHOUT access to this document.
export async function POST(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const parsed = requestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid access request." }, { status: 400 });
  }
  const outcome = await requestDocumentAccess({ documentId: id, userId: user.id, message: parsed.data.message });
  if (outcome.status === "not-found") {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  if (outcome.status === "has-access") {
    return NextResponse.json({ status: "has-access" });
  }
  if (outcome.notifyOwner) {
    console.log("[access-request] requested", { documentId: id, userId: user.id, requestId: outcome.requestId });
    void notifyAccessRequested({
      documentId: id,
      requester: { name: user.name, email: user.email },
      message: parsed.data.message
    });
  }
  return NextResponse.json({ status: "requested" });
}
