import { NextResponse } from "next/server";
import { z } from "zod";

import { createIntegrationAccount } from "@/lib/integration-accounts";
import { isIntegrationRequest } from "@/lib/integration-groups";
import { rateLimit } from "@/lib/rate-limit";

const schema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
  // The end user's IP as seen by the integration (every call comes from its host).
  clientIp: z.string().max(64).optional()
});

// POST /api/integrations/users — create an r-docs account from an
// integration's own sign-up form. Same rules as /api/auth/sign-up.
export async function POST(request: Request) {
  if (!isIntegrationRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Name (2+ chars), a valid email and a password of 8+ characters are required." }, { status: 400 });
  }
  const limit = rateLimit(`integration-sign-up:ip:${parsed.data.clientIp || "unknown"}`, 10, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ error: "Too many sign-up attempts. Try again shortly." }, { status: 429 });
  }
  const result = await createIntegrationAccount(parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ user: result.user, verificationEmailSent: result.verificationEmailSent }, { status: 201 });
}
