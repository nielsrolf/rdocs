import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { canManageDocumentAutomation, resolveDocumentAccess } from "@/lib/permissions";
import {
  getWorkspaceLink,
  listConnectableSlackChannelDocuments,
  setWorkspaceLink,
  WorkspaceLinkError
} from "@/lib/workspace-link";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

const patchSchema = z.object({
  // The slack_channel document whose workspace this document should use;
  // null disconnects.
  workspaceDocumentId: z.string().trim().min(1).max(64).nullable()
});

// Managing the workspace link is an automation change (it redirects where
// every agent run reads/writes), so it needs a signed-in user with edit
// access — same bar as env vars and skills.
async function requireAutomationAccess(documentId: string) {
  const user = await getCurrentUser();
  const access = await resolveDocumentAccess(documentId, user?.id, null);
  if (!user || !access || !canManageDocumentAutomation(access, user.id)) {
    return null;
  }
  return { user, access };
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const auth = await requireAutomationAccess(id);
  if (!auth) {
    return NextResponse.json({ error: "You do not have edit access." }, { status: 403 });
  }

  const [link, channels] = await Promise.all([
    getWorkspaceLink(id),
    listConnectableSlackChannelDocuments(auth.user.id)
  ]);

  return NextResponse.json({ link, channels });
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const auth = await requireAutomationAccess(id);
  if (!auth) {
    return NextResponse.json({ error: "You do not have edit access." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid workspace link payload." }, { status: 400 });
  }

  try {
    const link = await setWorkspaceLink({
      documentId: id,
      targetDocumentId: parsed.data.workspaceDocumentId,
      userId: auth.user.id
    });
    console.log(
      "[workspace-link]",
      JSON.stringify({
        documentId: id,
        userId: auth.user.id,
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
