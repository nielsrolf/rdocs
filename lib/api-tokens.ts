import crypto from "node:crypto";

import { db } from "@/lib/db";

// Personal access tokens for the MCP bridge. The plaintext (`gdai_<hex>`) is
// returned exactly once at creation; only the SHA-256 digest is persisted, so a
// DB leak does not leak usable tokens.

const TOKEN_PREFIX = "gdai_";
// Refresh lastUsedAt at most once a minute — it's an audit hint, not a metric.
const LAST_USED_REFRESH_MS = 60_000;

export function hashApiToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function maskApiToken(token: string) {
  return `${token.slice(0, TOKEN_PREFIX.length + 4)}…${token.slice(-4)}`;
}

export async function createApiToken(userId: string, label?: string | null) {
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
  const record = await db.apiToken.create({
    data: {
      userId,
      tokenHash: hashApiToken(token),
      label: label?.trim() ? label.trim().slice(0, 120) : null
    },
    select: { id: true, label: true, createdAt: true }
  });
  return { token, masked: maskApiToken(token), record };
}

export async function listApiTokens(userId: string) {
  return db.apiToken.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, label: true, createdAt: true, lastUsedAt: true }
  });
}

export async function revokeApiToken(userId: string, tokenId: string) {
  const result = await db.apiToken.updateMany({
    where: { id: tokenId, userId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
  return result.count > 0;
}

// Resolve an `Authorization: Bearer gdai_…` header to its user, or null. Used
// by /api/mcp, which has no browser cookie.
export async function resolveApiTokenUser(authorizationHeader: string | null | undefined) {
  const match = authorizationHeader?.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1];
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;

  const record = await db.apiToken.findUnique({
    where: { tokenHash: hashApiToken(token) },
    select: {
      id: true,
      revokedAt: true,
      lastUsedAt: true,
      user: { select: { id: true, email: true, name: true } }
    }
  });
  if (!record || record.revokedAt) return null;

  const now = Date.now();
  if (!record.lastUsedAt || now - record.lastUsedAt.getTime() > LAST_USED_REFRESH_MS) {
    // Fire-and-forget; a failed audit-timestamp update must not fail the request.
    void db.apiToken
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date(now) } })
      .catch(() => {});
  }

  return record.user;
}
