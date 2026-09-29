import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";

import { db } from "@/lib/db";

const SESSION_COOKIE = "gdocs_ai_session";
const encoder = new TextEncoder();

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;

  if (!secret) {
    throw new Error("SESSION_SECRET is required.");
  }

  return encoder.encode(secret);
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export async function createSessionToken(userId: string) {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getSessionSecret());
}

export async function readSessionToken(token: string) {
  return (await readSession(token))?.userId ?? null;
}

async function readSession(token: string) {
  try {
    const { payload } = await jwtVerify(token, getSessionSecret());
    return typeof payload.sub === "string"
      ? { userId: payload.sub, issuedAt: payload.iat ?? 0 }
      : null;
  } catch {
    return null;
  }
}

// Truncated to whole seconds to match JWT `iat`, so the session issued right
// after a password change (same second) still counts as newer.
export function passwordChangeInstant() {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (!token) {
    return null;
  }

  const session = await readSession(token);
  if (!session) {
    return null;
  }

  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      passwordChangedAt: true
    }
  });

  // Sessions from before the last password change are revoked.
  if (!user || (user.passwordChangedAt && session.issuedAt * 1000 < user.passwordChangedAt.getTime())) {
    return null;
  }

  const { passwordChangedAt: _passwordChangedAt, ...publicUser } = user;
  return publicUser;
}

export async function setSessionCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  });
}

export async function clearSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(0)
  });
}
