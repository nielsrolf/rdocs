import { NextResponse } from "next/server";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { DurableAppError, getDurableApp, stopDurableContainer } from "@/lib/durable-apps";

export const runtime = "nodejs";

// Owner-only: stop the workspace's durable container. The next agent run
// recreates it (fresh image, fresh published port); the app inside goes down
// until then — that is what "restart" means here.
export async function POST(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const auth = await requireDocumentAccess(request, id, "EDIT", {
    shareToken: null,
    requireUser: true,
    forbiddenMessage: "You do not have edit access."
  });
  if (!auth.ok) return auth.response;
  try {
    const app = await getDurableApp(id);
    const owner = await import("@/lib/db").then(({ db }) =>
      db.document.findUnique({ where: { id: app.workspaceDocumentId }, select: { ownerId: true } })
    );
    if (owner?.ownerId !== auth.user.id) {
      return NextResponse.json({ error: "Only the workspace owner can restart the durable app container." }, { status: 403 });
    }
    await stopDurableContainer(app.workspaceDocumentId);
    return NextResponse.json({ app: await getDurableApp(id), isOwner: true });
  } catch (error) {
    if (error instanceof DurableAppError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[durable-app] restart failed", error);
    return NextResponse.json({ error: "Could not stop the durable app container." }, { status: 500 });
  }
}
