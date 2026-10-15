import crypto from "node:crypto";

import { db } from "@/lib/db";

// Server-to-server group lookup for "Sign in with r-docs" integrations (todo
// uses it for team boards). Integrations already hold INTEGRATION_SIGNIN_SECRET
// and are fully trusted (see lib/integration-signin.ts); they authenticate with
// a bearer token derived from it, so operators configure no extra value and a
// leaked API token does not let anyone mint id tokens.

export function integrationApiToken(): string | null {
  const secret = process.env.INTEGRATION_SIGNIN_SECRET;
  if (!secret) return null;
  return crypto.createHash("sha256").update(`rdocs-integration-api:${secret}`).digest("hex");
}

export function isIntegrationRequest(authorization: string | null): boolean {
  const expected = integrationApiToken();
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!expected || !match) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export type IntegrationGroup = {
  id: string;
  name: string;
  ownerId: string;
  members: { userId: string; name: string; email: string; role: string }[];
};

// Groups the user owns or belongs to, with every member (the owner included).
export async function groupsForUser(userId: string): Promise<IntegrationGroup[]> {
  const groups = await db.group.findMany({
    where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      ownerId: true,
      owner: { select: { name: true, email: true } },
      members: {
        orderBy: { createdAt: "asc" },
        select: { userId: true, role: true, user: { select: { name: true, email: true } } }
      }
    }
  });
  return groups.map((g) => {
    const members = g.members.map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email, role: m.role }));
    if (!members.some((m) => m.userId === g.ownerId)) {
      members.unshift({ userId: g.ownerId, name: g.owner.name, email: g.owner.email, role: "owner" });
    }
    return { id: g.id, name: g.name, ownerId: g.ownerId, members };
  });
}
