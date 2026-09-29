import { NextResponse } from "next/server";
import { z } from "zod";

import { tokenMatchesPassword, verifyPasswordResetToken } from "@/lib/account-email";
import { createSessionToken, hashPassword, passwordChangeInstant, setSessionCookie } from "@/lib/auth";
import { db } from "@/lib/db";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

const resetSchema = z.object({
  token: z.string().min(1).max(4000),
  password: z.string().min(8).max(128)
});

export async function POST(request: Request) {
  const ipLimit = rateLimit(`reset-password:ip:${getClientIp(request)}`, 20, 60_000);
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = resetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Passwords need at least 8 characters." }, { status: 400 });
  }

  const claims = await verifyPasswordResetToken(parsed.data.token);
  const user = claims
    ? await db.user.findUnique({ where: { id: claims.userId }, select: { id: true, passwordHash: true } })
    : null;

  if (!claims || !user || !tokenMatchesPassword(claims.fingerprint, user.passwordHash)) {
    return NextResponse.json(
      { error: "This reset link has expired or was already used. Request a new one." },
      { status: 400 }
    );
  }

  // The link arrived by email, so it also confirms the address. Bumping
  // passwordChangedAt signs out every existing session (lib/auth.ts).
  await db.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(parsed.data.password),
      passwordChangedAt: passwordChangeInstant(),
      emailVerificationPending: false
    }
  });

  await setSessionCookie(await createSessionToken(user.id));
  return NextResponse.json({ ok: true });
}
