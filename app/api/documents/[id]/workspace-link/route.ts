import { NextResponse } from "next/server";
import { z } from "zod";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import {
  getWorkspaceLink,
  listConnectableSlackChannelDocuments,
  setWorkspaceLink,
  WorkspaceLinkError
} from "@/lib/workspace-link";

export const runtime = "nodejs";

const patchSchema = z.object({
  // The slack_channel document whose workspace this document should use;
  // null disconnects.
  workspaceDocumentId: z.string().trim().min(1).max(64).nullable()
});

// Managing the workspace link is an automation change (it redirects where
// every agent run reads/writes), so it needs a signed-in user with edit
// access — same bar as env vars and skills.
async function requireAutomationAccess(request: Request, documentId: string) {
  return requireDocumentAccess(request, documentId, "EDIT", {
    shareToken: null,
    requireUser: true,
    forbiddenMessage: "You do not have edit access."
  });
}

export async function GET(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const auth = await requireAutomationAccess(request, id);
  if (!auth.ok) {
    return auth.response;
  }
  const user = auth.user;

  const [link, channels] = await Promise.all([
    getWorkspaceLink(id),
    listConnectableSlackChannelDocuments(user.id)
  ]);

  return NextResponse.json({ link, channels });
}

export async function PATCH(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const auth = await requireAutomationAccess(request, id);
  if (!auth.ok) {
    return auth.response;
  }
  const user = auth.user;

  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid workspace link payload." }, { status: 400 });
  }

  try {
    const link = await setWorkspaceLink({
      documentId: id,
      targetDocumentId: parsed.data.workspaceDocumentId,
      userId: user.id
    });
    console.log(
      "[workspace-link]",
      JSON.stringify({
        documentId: id,
        userId: user.id,
        workspaceDocumentId: link?.id ?? null
      })
    );
    return NextResponse.json({ link });
  } catch (error) {
    if (error instanceof WorkspaceLinkError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
