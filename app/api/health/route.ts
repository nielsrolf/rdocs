import { NextResponse } from "next/server";

import { activeRunCount } from "@/lib/agent-runner/run-registry";
import { drainingSince, isDraining } from "@/lib/deploy-lifecycle";

// Liveness/readiness probe for the blue/green deploy (deploy/deploy.sh) and
// the load balancer. Returns 503 once the process is draining so health-based
// routing agrees with the explicit upstream switch.
export const dynamic = "force-dynamic";

export async function GET() {
  const draining = isDraining();
  return NextResponse.json(
    {
      ok: !draining,
      draining,
      drainingSince: drainingSince()?.toISOString() ?? null,
      activeRuns: activeRunCount(),
      pid: process.pid,
      port: process.env.PORT ?? null,
      distDir: process.env.NEXT_DIST_DIR ?? ".next",
      uptimeSec: Math.round(process.uptime())
    },
    { status: draining ? 503 : 200 }
  );
}
