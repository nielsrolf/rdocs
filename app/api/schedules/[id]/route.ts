import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import {
  cancelSchedule,
  getScheduleForUser,
  getScheduleHistory,
  MAX_SCHEDULE_INSTRUCTION_LENGTH,
  MAX_TITLE_LENGTH,
  ScheduleError,
  updateSchedule
} from "@/lib/schedules";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

function errorResponse(error: unknown) {
  if (error instanceof ScheduleError) return NextResponse.json({ error: error.message }, { status: error.status });
  throw error;
}

// One task with its recent firings.
export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { id } = await params;
  try {
    const [schedule, firings] = await Promise.all([
      getScheduleForUser(id, user.id),
      getScheduleHistory(id, { userId: user.id }, 20)
    ]);
    return NextResponse.json({ schedule, firings });
  } catch (error) {
    return errorResponse(error);
  }
}

const patchSchema = z
  .object({
    title: z.string().max(MAX_TITLE_LENGTH).nullable().optional(),
    instruction: z.string().min(1).max(MAX_SCHEDULE_INSTRUCTION_LENGTH).optional(),
    cron: z.string().min(9).max(100).nullable().optional(),
    at: z.string().min(10).max(40).nullable().optional(),
    timezone: z.string().max(64).nullable().optional(),
    paused: z.boolean().optional()
  })
  .strict();

export async function PATCH(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid change." }, { status: 400 });
  try {
    return NextResponse.json({ schedule: await updateSchedule(id, parsed.data, { userId: user.id }) });
  } catch (error) {
    return errorResponse(error);
  }
}

// Cancel (end for good). Pausing is PATCH { paused: true }.
export async function DELETE(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { id } = await params;
  try {
    return NextResponse.json({ schedule: await cancelSchedule(id, { userId: user.id }) });
  } catch (error) {
    return errorResponse(error);
  }
}
