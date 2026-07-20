import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveApiTokenUser } from "@/lib/api-tokens";
import { completeSelfHostedJob } from "@/lib/self-hosted-jobs";

export const runtime = "nodejs";

// The self-hosted worker reports the outcome of a claimed job here:
// `POST /api/self-hosted/jobs/:id/result` with the same bearer token used to
// claim it. Exactly one of `result` (success — the ClaudeResearchAgentOutput
// shape) or `error` (failure — a message string) must be present.
//
// This is the final-result-only counterpart of the ContainerRunner's NDJSON
// stream — no incremental progress frames yet (see the NOT DONE list in
// lib/agent-runner/self-hosted.ts).

const resultSchema = z
  .object({
    result: z.unknown().optional(),
    error: z.string().min(1).max(8000).optional()
  })
  .refine((data) => (data.result !== undefined) !== (data.error !== undefined), {
    message: "Exactly one of `result` or `error` is required."
  });

type RouteContext = { params: Promise<{ id: string }> };

function unauthorized() {
  return NextResponse.json({ error: "Invalid or missing API token." }, { status: 401 });
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await resolveApiTokenUser(request.headers.get("authorization"));
  if (!user) {
    return unauthorized();
  }

  const body = await request.json().catch(() => null);
  const parsed = resultSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  const ok = await completeSelfHostedJob(
    id,
    user.id,
    parsed.data.result !== undefined
      ? { status: "succeeded", resultPayload: parsed.data.result }
      : { status: "failed", error: parsed.data.error as string }
  );

  if (!ok) {
    return NextResponse.json({ error: "Job not found (or not owned by this token)." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
