import { NextResponse } from "next/server";

import { notSignedIn } from "@/lib/api-helpers";
import { getCurrentUser } from "@/lib/auth";
import { listTemplatesForUser } from "@/lib/templates";

// Every template the signed-in user can open, with their decision about it
// (status "added" | "dismissed" | null = not asked yet).
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return notSignedIn();
  return NextResponse.json({ templates: await listTemplatesForUser(user.id) });
}
