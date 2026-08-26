import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { isAllowedAgentSetupUrl } from "@/lib/agent-setup-origins";

export const runtime = "nodejs";

const schema = z.object({
  manifestUrl: z.string().url().max(2000),
  credential: z.string().min(1).max(1000)
});

// Same-origin browser seam for setup manifests. The server performs the
// allowlisted fetch so an HTTPS r-docs page can integrate with a tailnet-only
// HTTP service without mixed-content failures.
export async function POST(request: Request) {
  if (!(await getCurrentUser())) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !isAllowedAgentSetupUrl(parsed.data.manifestUrl)) {
    return NextResponse.json({ error: "This integration origin is not allowed." }, { status: 400 });
  }
  try {
    const response = await fetch(parsed.data.manifestUrl, {
      headers: { authorization: `Bearer ${parsed.data.credential}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000)
    });
    const body = await response.text();
    if (!response.ok) {
      return NextResponse.json({ error: "The integration rejected this setup link." }, { status: 502 });
    }
    return new NextResponse(body, { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    console.error("[agent-setup] manifest fetch failed", {
      error: error instanceof Error ? error.message : error
    });
    return NextResponse.json({ error: "Could not reach the integration service." }, { status: 502 });
  }
}
