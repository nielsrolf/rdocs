import { NextResponse } from "next/server";

import { groupsForUser, isIntegrationRequest } from "@/lib/integration-groups";

// GET /api/integrations/groups?userId=… — the groups a user belongs to, for a
// trusted integration (Authorization: Bearer <integration API token>).
export async function GET(request: Request) {
  if (!isIntegrationRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }
  const userId = new URL(request.url).searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId is required." }, { status: 400 });
  }
  return NextResponse.json({ groups: await groupsForUser(userId) });
}
