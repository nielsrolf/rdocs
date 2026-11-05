import { NextResponse } from "next/server";

import { getIntegrationGroup, isIntegrationRequest } from "@/lib/integration-groups";

type RouteContext = { params: Promise<{ groupId: string }> };

// GET /api/integrations/groups/:groupId — one group with all members.
export async function GET(request: Request, { params }: RouteContext) {
  if (!isIntegrationRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }
  const group = await getIntegrationGroup((await params).groupId);
  if (!group) return NextResponse.json({ error: "Group not found." }, { status: 404 });
  return NextResponse.json({ group });
}
