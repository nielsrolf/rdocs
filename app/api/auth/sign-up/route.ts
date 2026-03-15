import { NextResponse } from "next/server";
import { z } from "zod";

import { createSessionToken, hashPassword, setSessionCookie } from "@/lib/auth";
import { db } from "@/lib/db";

const signUpSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(128)
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = signUpSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid sign-up payload." }, { status: 400 });
  }

  const existingUser = await db.user.findUnique({
    where: {
      email: parsed.data.email.toLowerCase()
    },
    select: {
      id: true
    }
  });

  if (existingUser) {
    return NextResponse.json({ error: "That email is already in use." }, { status: 409 });
  }

  const user = await db.user.create({
    data: {
      email: parsed.data.email.toLowerCase(),
      name: parsed.data.name.trim(),
      passwordHash: await hashPassword(parsed.data.password)
    },
    select: {
      id: true
    }
  });

  await setSessionCookie(await createSessionToken(user.id));

  return NextResponse.json({ ok: true });
}
