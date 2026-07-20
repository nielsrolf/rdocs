import { NextResponse } from "next/server";

import { resolveApiTokenUser } from "@/lib/api-tokens";
import { claimNextSelfHostedJob } from "@/lib/self-hosted-jobs";

export const runtime = "nodejs";

// The self-hosted worker's poll loop: `POST /api/self-hosted/jobs/claim` with
// `Authorization: Bearer gdai_…` (same personal ApiToken minted for MCP —
// see the "Self-hosted setup" panel in document settings). Returns the oldest
// pending SelfHostedJob among documents the token's user OWNS, claimed
// atomically so two worker processes can't race the same job. `{ job: null }`
// (200) means "nothing to do right now" — the worker should just poll again.

function unauthorized() {
  return NextResponse.json({ error: "Invalid or missing API token." }, { status: 401 });
}

export async function POST(request: Request) {
  const user = await resolveApiTokenUser(request.headers.get("authorization"));
  if (!user) {
    return unauthorized();
  }

  const job = await claimNextSelfHostedJob(user.id);
  if (!job) {
    return NextResponse.json({ job: null });
  }

  return NextResponse.json({
    job: {
      id: job.id,
      documentId: job.documentId,
      aiRunId: job.aiRunId,
      claimedAt: job.claimedAt,
      // The serialized AgentJob (input + agentConfig + agentEnv + validation
      // spec) — parse and hand to the worker's own agent-core invocation.
      jobPayload: JSON.parse(job.jobPayload)
    }
  });
}
