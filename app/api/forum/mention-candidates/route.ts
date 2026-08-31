import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { loadForumMentionCandidates } from "@/lib/mention-data";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const candidates = (await loadForumMentionCandidates()).filter((candidate) => candidate.id !== user.id);
  return NextResponse.json({ candidates });
}
