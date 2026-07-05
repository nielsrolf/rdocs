import crypto from "node:crypto";
import { SignJWT } from "jose";

import { db } from "../../lib/db";

// Seed a user directly via Prisma and mint the session JWT locally (same
// HS256 + SESSION_SECRET scheme as lib/auth.ts). The HTTP sign-up route is
// rate-limited to 10/min/IP, so suites that create a user per test MUST seed
// this way — one dedicated test keeps real /api/auth/sign-up coverage.
export async function seedUser(): Promise<{ cookie: string; userId: string; email: string }> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required to mint integration-test sessions (load .env).");
  }

  const email = `int-${crypto.randomUUID()}@example.com`;
  const user = await db.user.create({
    data: {
      email,
      name: "Integration Test",
      // Random placeholder — password auth is exercised by the sign-up route test.
      passwordHash: crypto.randomUUID()
    },
    select: { id: true }
  });

  const token = await new SignJWT({ sub: user.id })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(new TextEncoder().encode(secret));

  return { cookie: `gdocs_ai_session=${token}`, userId: user.id, email };
}
