import crypto from "node:crypto";

import { db } from "@/lib/db";

const TOKEN_PREFIX = "gdach_";
const LAST_USED_REFRESH_MS = 60_000;

export function hashAgentApiToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function upsertAgentApiChannel(args: {
  documentId: string;
  createdById: string;
  label?: string | null;
}) {
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
  const channel = await db.agentApiChannel.upsert({
    where: { documentId: args.documentId },
    create: {
      documentId: args.documentId,
      createdById: args.createdById,
      label: args.label?.trim().slice(0, 120) || null,
      tokenHash: hashAgentApiToken(token)
    },
    update: {
      createdById: args.createdById,
      label: args.label?.trim().slice(0, 120) || null,
      tokenHash: hashAgentApiToken(token),
      revokedAt: null,
      lastUsedAt: null
    },
    select: { id: true, documentId: true, label: true, createdAt: true }
  });
  return { token, channel };
}

export async function resolveAgentApiChannel(
  triggerId: string,
  authorizationHeader: string | null | undefined
) {
  const match = authorizationHeader?.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1];
  if (!token?.startsWith(TOKEN_PREFIX)) return null;

  const channel = await db.agentApiChannel.findFirst({
    where: { id: triggerId, tokenHash: hashAgentApiToken(token), revokedAt: null },
    include: {
      document: true,
      createdBy: { select: { id: true, email: true, name: true } }
    }
  });
  if (!channel) return null;

  const now = Date.now();
  if (!channel.lastUsedAt || now - channel.lastUsedAt.getTime() > LAST_USED_REFRESH_MS) {
    void db.agentApiChannel
      .updateMany({ where: { id: channel.id, revokedAt: null }, data: { lastUsedAt: new Date(now) } })
      .catch(() => {});
  }
  return channel;
}

export async function revokeAgentApiChannel(documentId: string, createdById: string) {
  const result = await db.agentApiChannel.updateMany({
    where: { documentId, createdById, revokedAt: null },
    data: { revokedAt: new Date() }
  });
  return result.count > 0;
}
