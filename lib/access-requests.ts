// "Ask for permission": a signed-in user who opens a document they cannot read
// may ask its owner for access. One DocumentAccessRequest row per
// (document, user); the owner grants (→ a DocumentMembership) or declines it
// from the Share dialog. Someone who already HAS access can ask the same way
// for a higher level (view → comment/edit): `requestedPermission` on the row,
// and the request only counts while it asks for more than they have. Notifications are sent by the callers
// (notifyAccessRequested / notifyAccessGranted in lib/activity-notifications.ts),
// fire-and-forget.

import { permissionLevels, type PermissionLevelValue } from "@/lib/contracts";
import { db } from "@/lib/db";
import { resolveDocumentAccess } from "@/lib/permissions";

export const ACCESS_REQUEST_MESSAGE_MAX = 500;

export type AccessRequestOutcome =
  // No such document (or a kind that has no studio page).
  | { status: "not-found" }
  // The user already has it (or more than they asked for).
  | { status: "has-access" }
  // `notifyOwner` is true only when this call opened the request: asking again
  // while one is pending — or after the owner declined — never re-notifies.
  // `currentPermission` is what the requester has today (null = no access).
  | {
      status: "requested";
      requestId: string;
      notifyOwner: boolean;
      currentPermission: PermissionLevelValue | null;
    };

function rank(permission: string | null | undefined) {
  return permissionLevels.indexOf(permission as PermissionLevelValue) + 1;
}

function asPermission(value: string | null | undefined): PermissionLevelValue | null {
  return rank(value) > 0 ? (value as PermissionLevelValue) : null;
}

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

/**
 * For someone who can already open the document: the higher level they asked
 * for, if a request for more than `currentPermission` is out. Like the
 * no-access page, a declined request reads as still out.
 */
export async function getUpgradeRequestState(
  documentId: string,
  userId: string,
  currentPermission: PermissionLevelValue
): Promise<{ requestedPermission: PermissionLevelValue | null }> {
  const request = await db.documentAccessRequest.findUnique({
    where: { documentId_userId: { documentId, userId } },
    select: { status: true, requestedPermission: true }
  });
  const open = request?.status === "pending" || request?.status === "declined";
  const asked = asPermission(request?.requestedPermission);
  return { requestedPermission: open && asked && rank(asked) > rank(currentPermission) ? asked : null };
}

export async function requestDocumentAccess(input: {
  documentId: string;
  userId: string;
  message?: string | null;
  // The level asked for. Required to ask for MORE than you already have.
  permission?: PermissionLevelValue | null;
}): Promise<AccessRequestOutcome> {
  const document = await requestableDocument(input.documentId);
  if (!document) return { status: "not-found" };
  const access = await resolveDocumentAccess(input.documentId, input.userId);
  const currentPermission = access?.permission ?? null;
  const wanted = input.permission ?? null;
  if (access && rank(wanted) <= rank(access.permission)) return { status: "has-access" };

  const message = cleanMessage(input.message);
  const key = { documentId_userId: { documentId: input.documentId, userId: input.userId } };
  const existing = await db.documentAccessRequest.findUnique({
    where: key,
    select: { id: true, status: true, requestedPermission: true }
  });
  // An older request the requester's current access already covers (asked for
  // access, got it some other way) is history: it neither blocks nor answers
  // this one.
  const superseded =
    existing && access && rank(existing.requestedPermission ?? "VIEW") <= rank(access.permission);
  if (existing && existing.status !== "granted" && !superseded) {
    // Pending: keep it (a new message replaces the old one, a higher level
    // raises the ask). Declined: stays declined.
    if (existing.status === "pending") {
      const raise = rank(wanted) > rank(existing.requestedPermission);
      if (message || raise) {
        await db.documentAccessRequest.update({
          where: { id: existing.id },
          data: { ...(message ? { message } : {}), ...(raise ? { requestedPermission: wanted } : {}) }
        });
      }
    }
    return { status: "requested", requestId: existing.id, notifyOwner: false, currentPermission };
  }
  // New, granted earlier (and the access was removed, or more is wanted now),
  // or superseded: (re)open it.
  const request = await db.documentAccessRequest.upsert({
    where: key,
    create: { documentId: input.documentId, userId: input.userId, message, requestedPermission: wanted },
    update: { status: "pending", message, requestedPermission: wanted, resolvedAt: null },
    select: { id: true }
  });
  return { status: "requested", requestId: request.id, notifyOwner: true, currentPermission };
}

/**
 * Open requests of one document, oldest first. `currentPermission` is the
 * requester's membership today (null = none). A requester whose membership
 * already covers what they asked for (got access some other way) is dropped.
 */
export async function listPendingAccessRequests(documentId: string) {
  const rows = await db.documentAccessRequest.findMany({
    where: { documentId, status: "pending" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      message: true,
      requestedPermission: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          memberships: { where: { documentId }, select: { permission: true } }
        }
      }
    }
  });
  return rows.flatMap((row) => {
    const { memberships, ...user } = row.user;
    const currentPermission = asPermission(memberships[0]?.permission);
    const requestedPermission = asPermission(row.requestedPermission);
    if (currentPermission && rank(requestedPermission) <= rank(currentPermission)) return [];
    return [{ id: row.id, message: row.message, createdAt: row.createdAt, requestedPermission, currentPermission, user }];
  });
}

export async function countPendingAccessRequests(documentId: string) {
  return (await listPendingAccessRequests(documentId)).length;
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
    select: { id: true, userId: true, requestedPermission: true }
  });
  if (!request) return { status: "not-found" };

  if (input.action === "decline") {
    await db.documentAccessRequest.update({
      where: { id: request.id },
      data: { status: "declined", resolvedAt: new Date() }
    });
    return { status: "declined" };
  }

  const permission = input.permission ?? asPermission(request.requestedPermission) ?? "VIEW";
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
