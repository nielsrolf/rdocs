import { NextResponse } from "next/server";
import { z } from "zod";

import { addIntegrationGroupMember, isIntegrationRequest } from "@/lib/integration-groups";

type RouteContext = { params: Promise<{ groupId: string }> };

const schema = z.object({ userId: z.string().min(1) });

// POST /api/integrations/groups/:groupId/members {userId} — add a member
// (idempotent). The integration decides who may join, e.g. via an invite link.
export async function POST(request: Request, { params }: RouteContext) {
  if (!isIntegrationRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }
  const { groupId } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "userId is required." }, { status: 400 });
  const group = await addIntegrationGroupMember(groupId, parsed.data.userId);
  if (!group) return NextResponse.json({ error: "Unknown group or user." }, { status: 404 });
  console.log("[integrations] group member added", { groupId, memberId: parsed.data.userId });
  return NextResponse.json({ group });
}
