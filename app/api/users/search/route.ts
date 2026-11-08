import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { searchUsers } from "@/lib/user-search";

// GET /api/users/search?q=<text>[&limit=8][&exclude=id1,id2]
// Autocomplete for people pickers (group members, share dialog).
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? "8");
  const users = await searchUsers({
    viewerId: user.id,
    query: url.searchParams.get("q") ?? "",
    limit: Number.isFinite(limit) ? limit : 8,
    excludeIds: (url.searchParams.get("exclude") ?? "").split(",").filter(Boolean)
  });
  return NextResponse.json({ users });
}
