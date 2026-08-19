import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { listCatalogSkills } from "@/lib/skill-catalog";

export const runtime = "nodejs";

// The curated skill catalog (a public git repo of skill folders, see
// lib/skill-catalog.ts). Signed-in users see the list and install entries
// with one click via the user/document skill routes ({ catalogName }).
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  try {
    const skills = await listCatalogSkills();
    return NextResponse.json({ skills });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load the skill catalog." },
      { status: 502 }
    );
  }
}
