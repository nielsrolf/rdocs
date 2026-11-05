import { NextResponse } from "next/server";
import { z } from "zod";

import { checkIntegrationPassword } from "@/lib/integration-accounts";
import { isIntegrationRequest } from "@/lib/integration-groups";
import { rateLimit } from "@/lib/rate-limit";

const schema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(128),
  clientIp: z.string().max(64).optional()
});

// POST /api/integrations/sign-in — check an email/password typed into an
// integration's own sign-in form. Same rules as /api/auth/sign-in; sets no
// r-docs cookie (the integration opens its own session).
export async function POST(request: Request) {
  if (!isIntegrationRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  const tooMany = NextResponse.json({ error: "Too many sign-in attempts. Try again shortly." }, { status: 429 });
  if (!rateLimit(`integration-sign-in:ip:${parsed.data.clientIp || "unknown"}`, 20, 60_000).allowed) return tooMany;
  if (!rateLimit(`sign-in:email:${parsed.data.email.toLowerCase()}`, 10, 60_000).allowed) return tooMany;
  const result = await checkIntegrationPassword(parsed.data.email, parsed.data.password);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, needsVerification: result.needsVerification }, { status: result.status });
  }
  return NextResponse.json({ user: result.user });
}
