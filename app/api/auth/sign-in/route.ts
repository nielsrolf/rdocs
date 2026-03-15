import { NextResponse } from "next/server";
import { z } from "zod";

import { createSessionToken, setSessionCookie, verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128)
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = signInSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid sign-in payload." }, { status: 400 });
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
