import { NextResponse } from "next/server";
import { z } from "zod";

import { createIntegrationGroup, groupsForUser, isIntegrationRequest } from "@/lib/integration-groups";

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

const createSchema = z.object({ name: z.string().trim().min(1).max(120), ownerId: z.string().min(1) });

// POST /api/integrations/groups {name, ownerId} — create a group owned by a user.
export async function POST(request: Request) {
  if (!isIntegrationRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "name and ownerId are required." }, { status: 400 });
  const group = await createIntegrationGroup(parsed.data.name, parsed.data.ownerId);
  if (!group) return NextResponse.json({ error: "Unknown owner." }, { status: 404 });
  console.log("[integrations] group created", { groupId: group.id, ownerId: group.ownerId });
  return NextResponse.json({ group }, { status: 201 });
}
