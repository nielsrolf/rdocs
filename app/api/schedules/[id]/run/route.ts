import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { runScheduleNow, ScheduleError } from "@/lib/schedules";

export const runtime = "nodejs";

// Run now: fire the task once without touching its schedule (logged as a
// "manual" firing). Returns quickly — the run itself continues in the background.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { id } = await params;
  try {
    const result = await runScheduleNow(id, { userId: user.id });
    return NextResponse.json({ result }, { status: result.outcome === "started" || result.outcome === "injected" ? 200 : 409 });
  } catch (error) {
    if (error instanceof ScheduleError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
