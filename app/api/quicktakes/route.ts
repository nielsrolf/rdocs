import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import {
  createQuicktake,
  listQuicktakes,
  QUICKTAKE_MAX_LENGTH,
  QuicktakeError
} from "@/lib/quicktakes";

const createSchema = z.object({
  body: z.string().min(1).max(QUICKTAKE_MAX_LENGTH)
});

// The viewer's quicktake feed (public + own + group-shared), newest first.
// Works logged-out (public quicktakes only).
export async function GET() {
  const user = await getCurrentUser();
  const quicktakes = await listQuicktakes(user?.id ?? null);
  return NextResponse.json({ quicktakes });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid quicktake payload." }, { status: 400 });
  }
  try {
    const quicktake = await createQuicktake(user.id, parsed.data.body);
    console.log("[quicktake] created", {
      quicktakeId: quicktake.id,
      userId: user.id,
      isPublic: quicktake.isPublic
    });
    return NextResponse.json({ quicktake }, { status: 201 });
  } catch (error) {
    if (error instanceof QuicktakeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
