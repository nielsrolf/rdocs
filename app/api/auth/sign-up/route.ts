import { NextResponse } from "next/server";
import { z } from "zod";

import { sendVerificationEmail } from "@/lib/account-email";
import { createSessionToken, hashPassword, setSessionCookie } from "@/lib/auth";
import { db } from "@/lib/db";
import { emailEnabled } from "@/lib/email";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { getPublicOrigin } from "@/lib/request-origin";

const signUpSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  returnTo: z.string().max(2000).optional()
});

export async function POST(request: Request) {
  // Limit account-creation bursts from a single source.
  const ipLimit = rateLimit(`sign-up:ip:${getClientIp(request)}`, 10, 60_000);
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "Too many sign-up attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = signUpSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid sign-up payload." }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();
  const existingUser = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      emailVerificationPending: true
    }
  });

  // An unconfirmed account can be claimed again: whoever controls the inbox
  // is the owner, so a re-sign-up replaces the name/password and sends a new
  // link. Links sent for the previous password stop working (they are bound
  // to its hash), so only the newest sign-up can be confirmed.
  if (existingUser && !existingUser.emailVerificationPending) {
    return NextResponse.json({ error: "That email is already in use." }, { status: 409 });
  }

  // Without a mail transport there is no way to confirm, so keep the old
  // sign-up-and-sign-in behaviour.
  const requireVerification = emailEnabled();
  const data = {
    name: parsed.data.name.trim(),
    passwordHash: await hashPassword(parsed.data.password),
    emailVerificationPending: requireVerification
  };
  const userFields = { id: true, email: true, name: true, passwordHash: true } as const;
  const user = existingUser
    ? await db.user.update({ where: { id: existingUser.id }, data, select: userFields })
    : await db.user.create({ data: { email, ...data }, select: userFields });

  if (requireVerification) {
    try {
      await sendVerificationEmail(user, getPublicOrigin(request.headers, request.url), parsed.data.returnTo);
    } catch (error) {
      console.error("[auth] verification email failed", error);
      return NextResponse.json(
        { error: "Your account was created, but the confirmation email could not be sent. Try signing in to resend it." },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, needsVerification: true, email });
  }

  await setSessionCookie(await createSessionToken(user.id));

  return NextResponse.json({ ok: true, needsVerification: false });
}
