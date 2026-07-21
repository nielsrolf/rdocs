import crypto from "node:crypto";

import { NextResponse } from "next/server";

import { activeRunCount } from "@/lib/agent-runner/run-registry";
import { beginDrain, isDraining } from "@/lib/deploy-lifecycle";

// Begin graceful drain of THIS process (blue/green deploy). The deploy script
// calls this on the OLD process's port after switching the load balancer:
//   curl -X POST -H "Authorization: Bearer $DEPLOY_SECRET" \
//     http://localhost:<oldPort>/api/admin/drain
// Guarded by DEPLOY_SECRET from .env; disabled entirely when unset.
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.DEPLOY_SECRET?.trim();
  if (!secret) {
    return false;
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) {
    return false;
  }
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!process.env.DEPLOY_SECRET?.trim()) {
    return NextResponse.json({ error: "Drain endpoint is not configured." }, { status: 404 });
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { alreadyDraining } = beginDrain();
  return NextResponse.json({
    ok: true,
    alreadyDraining: alreadyDraining || undefined,
    draining: isDraining(),
    activeRuns: activeRunCount(),
    pid: process.pid
  });
}
