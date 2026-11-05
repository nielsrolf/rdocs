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

// Groups an integration manages on a user's behalf (forecasting tournaments).
// The owner sees and manages the group in r-docs like any other group, so
// r-docs stays the source of truth for who is in it.

export async function getIntegrationGroup(groupId: string): Promise<IntegrationGroup | null> {
  const g = await db.group.findUnique({
    where: { id: groupId },
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
  if (!g) return null;
  const members = g.members.map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email, role: m.role }));
  if (!members.some((m) => m.userId === g.ownerId)) {
    members.unshift({ userId: g.ownerId, name: g.owner.name, email: g.owner.email, role: "owner" });
  }
  return { id: g.id, name: g.name, ownerId: g.ownerId, members };
}

export async function createIntegrationGroup(name: string, ownerId: string): Promise<IntegrationGroup | null> {
  const owner = await db.user.findUnique({ where: { id: ownerId }, select: { id: true } });
  if (!owner) return null;
  const group = await db.group.create({
    data: { name, ownerId, members: { create: { userId: ownerId, role: "owner" } } },
    select: { id: true }
  });
  return getIntegrationGroup(group.id);
}

// Idempotent. Returns null when the group or the user does not exist.
export async function addIntegrationGroupMember(groupId: string, userId: string): Promise<IntegrationGroup | null> {
  const [group, user] = await Promise.all([
    db.group.findUnique({ where: { id: groupId }, select: { id: true } }),
    db.user.findUnique({ where: { id: userId }, select: { id: true } })
  ]);
  if (!group || !user) return null;
  await db.groupMember.upsert({
    where: { groupId_userId: { groupId, userId } },
    create: { groupId, userId },
    update: {}
  });
  return getIntegrationGroup(groupId);
}
