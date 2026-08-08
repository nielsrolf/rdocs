import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import {
  getQuicktakeVisibility,
  QuicktakeError,
  setQuicktakeVisibility
} from "@/lib/quicktakes";

const patchSchema = z.object({
  // null = public quicktakes; a group id = visible to that group only.
  groupId: z.string().min(1).max(100).nullable()
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const visibility = await getQuicktakeVisibility(user.id);
  return NextResponse.json({ visibility });
}

// Updating the setting retroactively re-shares EVERY existing quicktake of
// the user — one visibility for all of them, by design.
export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid settings payload." }, { status: 400 });
  }
  try {
    const visibility = await setQuicktakeVisibility(user.id, parsed.data.groupId);
    console.log("[quicktake] visibility updated", {
      userId: user.id,
      groupId: parsed.data.groupId
    });
    return NextResponse.json({ visibility });
  } catch (error) {
    if (error instanceof QuicktakeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
