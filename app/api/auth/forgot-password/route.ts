import { NextResponse } from "next/server";
import { z } from "zod";

import { sendPasswordResetEmail } from "@/lib/account-email";
import { db } from "@/lib/db";
import { emailEnabled } from "@/lib/email";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { getPublicOrigin } from "@/lib/request-origin";

const forgotSchema = z.object({
  email: z.string().email()
});

// Always answers the same way whether or not the address has an account.
export async function POST(request: Request) {
  if (!emailEnabled()) {
    return NextResponse.json({ error: "Password reset by email is not available on this server." }, { status: 503 });
  }

  const ipLimit = rateLimit(`forgot-password:ip:${getClientIp(request)}`, 10, 60_000);
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = forgotSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();
  // Per-address cap so nobody can flood someone else's inbox. Over the cap we
  // still answer ok — the earlier email is on its way.
  const emailLimit = rateLimit(`forgot-password:email:${email}`, 3, 15 * 60_000);
  if (emailLimit.allowed) {
    const user = await db.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, passwordHash: true }
    });
    if (user) {
      try {
        await sendPasswordResetEmail(user, getPublicOrigin(request.headers, request.url));
      } catch (error) {
        console.error("[auth] password reset email failed", error);
        return NextResponse.json({ error: "The email could not be sent. Try again in a minute." }, { status: 502 });
      }
    }
  }

  return NextResponse.json({ ok: true });
}
