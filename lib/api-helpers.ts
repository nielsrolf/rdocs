import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { PermissionLevelValue } from "@/lib/contracts";
import { canComment, canEdit, resolveDocumentAccess } from "@/lib/permissions";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

// Shared shape of Next.js App Router dynamic route contexts:
//   export async function GET(request: Request, { params }: RouteContext<{ id: string }>)
export type RouteContext<P> = { params: Promise<P> };

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
export type DocumentAccess = NonNullable<Awaited<ReturnType<typeof resolveDocumentAccess>>>;

export function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export function notSignedIn(): NextResponse {
  return jsonError(401, "Not signed in.");
}

export function documentNotFound(): NextResponse {
  return jsonError(404, "Document not found.");
}

// Share tokens arrive either as a `?share=` query parameter (GET-ish routes)
// or as a `shareToken` field on a JSON body (mutating routes) — accept both.
export function readShareToken(request: Request, body?: unknown): string | null {
  const fromQuery = new URL(request.url).searchParams.get("share");
  if (fromQuery) return fromQuery;
  if (body && typeof body === "object") {
    const token = (body as { shareToken?: unknown }).shareToken;
    if (typeof token === "string" && token) return token;
  }
  return null;
}

const LEVEL_CHECK: Record<PermissionLevelValue, (permission: PermissionLevelValue) => boolean> = {
  VIEW: () => true,
  COMMENT: canComment,
  EDIT: canEdit
};

const DEFAULT_FORBIDDEN: Record<PermissionLevelValue, string> = {
  VIEW: "You do not have access to this document.",
  COMMENT: "You do not have comment access.",
  EDIT: "You do not have edit access."
};

export type RequireDocumentAccessOptions = {
  // JSON body already read from the request — checked for `shareToken`.
  body?: unknown;
  // Explicit share token; overrides readShareToken() when provided (pass null
  // to disable share-token access entirely).
  shareToken?: string | null;
  // 403 message when the caller has access but below `minLevel`.
  forbiddenMessage?: string;
  // Require a signed-in account even when a share token grants the level
  // (e.g. voting, automation changes).
  requireUser?: boolean;
};

export type RequireDocumentAccessResult<User = CurrentUser | null> =
  | {
      ok: true;
      user: User;
      access: DocumentAccess;
      shareToken: string | null;
    }
  | { ok: false; response: NextResponse };

// The shared document-access ritual: current user → share token →
// resolveDocumentAccess → standardized error responses.
//
// Response policy (deliberate, uniform):
// - anonymous caller with no access → 401 "Not signed in." (signing in may help)
// - signed-in caller with no access, or document missing → 404 "Document not
//   found." (no existence leak)
// - some access but below `minLevel` → 403 with the route's message.
export async function requireDocumentAccess(
  request: Request,
  documentId: string,
  minLevel: PermissionLevelValue,
  opts: RequireDocumentAccessOptions & { requireUser: true }
): Promise<RequireDocumentAccessResult<CurrentUser>>;
export async function requireDocumentAccess(
  request: Request,
  documentId: string,
  minLevel: PermissionLevelValue,
  opts?: RequireDocumentAccessOptions
): Promise<RequireDocumentAccessResult>;
export async function requireDocumentAccess(
  request: Request,
  documentId: string,
  minLevel: PermissionLevelValue,
  opts: RequireDocumentAccessOptions = {}
): Promise<RequireDocumentAccessResult> {
  const user = await getCurrentUser();
  const shareToken =
    opts.shareToken !== undefined ? opts.shareToken : readShareToken(request, opts.body);
  const access = await resolveDocumentAccess(documentId, user?.id, shareToken);

  if (!access) {
    return { ok: false, response: user ? documentNotFound() : notSignedIn() };
  }
  if (opts.requireUser && !user) {
    return { ok: false, response: notSignedIn() };
  }
  if (!LEVEL_CHECK[minLevel](access.permission)) {
    return {
      ok: false,
      response: jsonError(403, opts.forbiddenMessage ?? DEFAULT_FORBIDDEN[minLevel])
    };
  }

  return { ok: true, user, access, shareToken };
}

// Agent runs are expensive; cap how many a single user can kick off per
// minute to prevent cost-amplification / DoS. Anonymous visitors (share-token
// bearers) are keyed by IP. Returns a 429 response when over budget, else null.
export function rateLimitAiRun(
  user: { id: string } | null | undefined,
  request: Request,
  message = "You're starting AI runs too quickly. Try again shortly."
): NextResponse | null {
  const key = user ? `ai-run:user:${user.id}` : `ai-run:ip:${getClientIp(request)}`;
  const limit = rateLimit(key, 10, 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: message },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }
  return null;
}
