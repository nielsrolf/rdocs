import { NextResponse } from "next/server";
import { z } from "zod";

import { sendVerificationEmail } from "@/lib/account-email";
import { db } from "@/lib/db";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { getPublicOrigin } from "@/lib/request-origin";

const resendSchema = z.object({
  email: z.string().email(),
  returnTo: z.string().max(2000).optional()
});

// Always answers the same way, so it can't be used to probe which addresses
// have (unconfirmed) accounts.
export async function POST(request: Request) {
  const ipLimit = rateLimit(`resend-verification:ip:${getClientIp(request)}`, 10, 60_000);
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = resendSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();
  // Per-address cap so nobody can flood someone else's inbox.
  const emailLimit = rateLimit(`resend-verification:email:${email}`, 3, 15 * 60_000);
  if (!emailLimit.allowed) {
    return NextResponse.json(
      { error: "A confirmation email was sent recently. Check your inbox (and spam folder), or try again later." },
      { status: 429, headers: { "Retry-After": String(emailLimit.retryAfterSeconds) } }
    );
  }

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, passwordHash: true, emailVerificationPending: true }
  });

  if (user?.emailVerificationPending) {
    try {
      await sendVerificationEmail(user, getPublicOrigin(request.headers, request.url), parsed.data.returnTo);
    } catch (error) {
      console.error("[auth] verification email failed", error);
      return NextResponse.json({ error: "The email could not be sent. Try again in a minute." }, { status: 502 });
    }
  }

  return NextResponse.json({ ok: true });
}
