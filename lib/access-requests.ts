// "Ask for permission": a signed-in user who opens a document they cannot read
// may ask its owner for access. One DocumentAccessRequest row per
// (document, user); the owner grants (→ a DocumentMembership) or declines it
// from the Share dialog. Notifications are sent by the callers
// (notifyAccessRequested / notifyAccessGranted in lib/activity-notifications.ts),
// fire-and-forget.

import type { PermissionLevelValue } from "@/lib/contracts";
import { db } from "@/lib/db";
import { resolveDocumentAccess } from "@/lib/permissions";

export const ACCESS_REQUEST_MESSAGE_MAX = 500;

export type AccessRequestOutcome =
  // No such document (or a kind that has no studio page).
  | { status: "not-found" }
  // The user can already open it.
  | { status: "has-access" }
  // `notifyOwner` is true only when this call opened the request: asking again
  // while one is pending — or after the owner declined — never re-notifies.
  | { status: "requested"; requestId: string; notifyOwner: boolean };

function cleanMessage(message: string | null | undefined) {
  const trimmed = (message ?? "").replace(/\s+/g, " ").trim().slice(0, ACCESS_REQUEST_MESSAGE_MAX);
  return trimmed || null;
}

/** Documents that have an "ask for permission" page: everything but quick takes. */
async function requestableDocument(documentId: string) {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: { id: true, kind: true, ownerId: true }
  });
  return document && document.kind !== "quicktake" ? document : null;
}

/**
 * What the no-access page shows for this user: null when there is nothing to
 * ask for (no such document), otherwise whether a request is already out.
 * A declined request reads as still pending — the requester is not told.
 */
export async function getAccessRequestState(documentId: string, userId: string) {
  const document = await requestableDocument(documentId);
  if (!document) return null;
  const request = await db.documentAccessRequest.findUnique({
    where: { documentId_userId: { documentId, userId } },
    select: { status: true }
  });
  return { requested: request?.status === "pending" || request?.status === "declined" };
}

export async function requestDocumentAccess(input: {
  documentId: string;
  userId: string;
  message?: string | null;
}): Promise<AccessRequestOutcome> {
  const document = await requestableDocument(input.documentId);
  if (!document) return { status: "not-found" };
  if (await resolveDocumentAccess(input.documentId, input.userId)) return { status: "has-access" };

  const message = cleanMessage(input.message);
  const key = { documentId_userId: { documentId: input.documentId, userId: input.userId } };
  const existing = await db.documentAccessRequest.findUnique({
    where: key,
    select: { id: true, status: true }
  });
  if (existing && existing.status !== "granted") {
    // Pending: keep it (a new message replaces the old one). Declined: stays declined.
    if (existing.status === "pending" && message) {
      await db.documentAccessRequest.update({ where: { id: existing.id }, data: { message } });
    }
    return { status: "requested", requestId: existing.id, notifyOwner: false };
  }
  // New, or granted earlier and the access was removed since: (re)open it.
  const request = await db.documentAccessRequest.upsert({
    where: key,
    create: { documentId: input.documentId, userId: input.userId, message },
    update: { status: "pending", message, resolvedAt: null },
    select: { id: true }
  });
  return { status: "requested", requestId: request.id, notifyOwner: true };
}

const requestSelect = {
  id: true,
  message: true,
  createdAt: true,
  user: { select: { id: true, name: true, email: true } }
} as const;

/** Open requests of one document, oldest first. Requesters who got access some other way are dropped. */
export async function listPendingAccessRequests(documentId: string) {
  return db.documentAccessRequest.findMany({
    where: {
      documentId,
      status: "pending",
      user: { memberships: { none: { documentId } } }
    },
    orderBy: { createdAt: "asc" },
    select: requestSelect
  });
}

export async function countPendingAccessRequests(documentId: string) {
  return db.documentAccessRequest.count({
    where: { documentId, status: "pending", user: { memberships: { none: { documentId } } } }
  });
}

export type AccessRequestResolution =
  | { status: "not-found" }
  | { status: "declined" }
  | {
      status: "granted";
      requesterId: string;
      membership: {
        id: string;
        permission: PermissionLevelValue;
        user: { id: string; name: string; email: string };
      };
    };

/** Owner decision on a pending request. Authorization (owner-only) is the caller's job. */
export async function resolveAccessRequest(input: {
  documentId: string;
  requestId: string;
  action: "grant" | "decline";
  permission?: PermissionLevelValue;
}): Promise<AccessRequestResolution> {
  const request = await db.documentAccessRequest.findFirst({
    where: { id: input.requestId, documentId: input.documentId, status: "pending" },
    select: { id: true, userId: true }
  });
  if (!request) return { status: "not-found" };

  if (input.action === "decline") {
    await db.documentAccessRequest.update({
      where: { id: request.id },
      data: { status: "declined", resolvedAt: new Date() }
    });
    return { status: "declined" };
  }

  const permission = input.permission ?? "VIEW";
  const [membership] = await db.$transaction([
    db.documentMembership.upsert({
      where: { documentId_userId: { documentId: input.documentId, userId: request.userId } },
      create: { documentId: input.documentId, userId: request.userId, permission },
      update: { permission },
      select: { id: true, permission: true, user: { select: { id: true, name: true, email: true } } }
    }),
    db.documentAccessRequest.update({
      where: { id: request.id },
      data: { status: "granted", resolvedAt: new Date() }
    })
  ]);
  return {
    status: "granted",
    requesterId: request.userId,
    membership: { ...membership, permission: membership.permission as PermissionLevelValue }
  };
}
