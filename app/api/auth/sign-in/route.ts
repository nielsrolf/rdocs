import { NextResponse } from "next/server";
import { z } from "zod";

import { createSessionToken, setSessionCookie, verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128)
});

export async function POST(request: Request) {
  // Throttle online password guessing / credential stuffing per source IP.
  const ipLimit = rateLimit(`sign-in:ip:${getClientIp(request)}`, 20, 60_000);
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = signInSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid sign-in payload." }, { status: 400 });
  }

  // Also throttle per-account so one targeted email can't be hammered from many IPs.
  const emailLimit = rateLimit(`sign-in:email:${parsed.data.email.toLowerCase()}`, 10, 60_000);
  if (!emailLimit.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(emailLimit.retryAfterSeconds) } }
    );
  }

  const user = await db.user.findUnique({
    where: {
      email: parsed.data.email.toLowerCase()
    },
    select: {
      id: true,
      passwordHash: true
    }
  });

  if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });
  }

  await setSessionCookie(await createSessionToken(user.id));

  return NextResponse.json({ ok: true });
}
