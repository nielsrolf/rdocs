import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveApiTokenUser } from "@/lib/api-tokens";
import { recordSelfHostedProgress } from "@/lib/self-hosted-jobs";

export const runtime = "nodejs";

const progressSchema = z.object({
  events: z
    .array(
      z.object({
        role: z.enum(["agent", "tool", "tool_result", "system", "error"]).optional(),
        message: z.string().min(1).max(16000)
      })
    )
    .max(50)
});

// Worker → app progress stream for a claimed SelfHostedJob: frames land in
// (an EMPTY events array is a pure cancellation/liveness check — long silent
// tool calls emit no frames, but the worker still needs to hear about aborts)
//
// the run's AiRunEvent timeline (so the agent panel shows live progress) and
// the latest one becomes AiRun.progress. The response's `cancelled` flag is
// ALSO the cancellation channel: when the app-side run was aborted, the
// worker must stop the job and discard its result.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await resolveApiTokenUser(request.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Invalid or missing API token." }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = progressSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid progress payload." }, { status: 400 });
  }
  const outcome = await recordSelfHostedProgress(id, user.id, parsed.data.events);
  if (!outcome.ok && !outcome.cancelled) {
    return NextResponse.json({ error: "Unknown job, not yours, or not claimed." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, cancelled: outcome.cancelled });
}
