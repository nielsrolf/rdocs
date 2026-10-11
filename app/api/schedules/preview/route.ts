import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { computeNextRunAt, describeCron, previewNextRuns } from "@/lib/schedules";

export const runtime = "nodejs";

const schema = z.object({
  cron: z.string().max(100).optional().nullable(),
  at: z.string().max(40).optional().nullable(),
  timezone: z.string().max(64).optional().nullable()
});

// Live preview for the schedule form: plain-words description and the next
// three firings, or the validation error the save would hit.
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input." }, { status: 400 });
  const { cron, at, timezone } = parsed.data;
  try {
    const first = computeNextRunAt({ cron: cron || null, at: at || null, timezone: timezone || null });
    const nextRuns = cron ? previewNextRuns(cron, timezone || null, 3) : [first];
    return NextResponse.json({
      description: cron ? `${describeCron(cron)} (${timezone || "UTC"})` : "Once",
      nextRuns: nextRuns.map((date) => date.toISOString())
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
