// What the credential broker does for Tinker beyond swapping the key.
//
// 1. The SDK asks `GET /api/v1/client/config` first. When the answer has
//    `pjwt_auth_enabled`, it exchanges the API key for a short-lived JWT and
//    sends THAT from then on — a real credential the broker never issued, and
//    one it could not match to a run. We answer with the flag off, so the SDK
//    keeps presenting the (virtual) API key on every request.
// 2. Tinker bills by session, and its billing report carries each session's
//    `user_metadata`. The cost dashboard reads `user_metadata.project` as the
//    project that pays. A workspace with a budget has a cost project, so the
//    proxy writes it into every `create_session` — the agent does not have to
//    remember to tag anything, and cannot bill another project by accident.
//    A project the caller set itself is kept only when there is no budget.

export const TINKER_PROVIDER = "tinker";

const endsWith = (pathSegments: string[], ...tail: string[]) =>
  tail.every((part, index) => pathSegments[pathSegments.length - tail.length + index] === part);

export function isTinkerCreateSession(method: string, pathSegments: string[]): boolean {
  return method.toUpperCase() === "POST" && endsWith(pathSegments, "api", "v1", "create_session");
}

export function isTinkerClientConfig(pathSegments: string[]): boolean {
  return endsWith(pathSegments, "api", "v1", "client", "config");
}

/** The create_session body with the cost project as `user_metadata.project`. */
export function tagTinkerSession(body: Uint8Array<ArrayBuffer>, costsProject: string): Uint8Array<ArrayBuffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
  const request = parsed as Record<string, unknown>;
  const metadata =
    request.user_metadata && typeof request.user_metadata === "object" && !Array.isArray(request.user_metadata)
      ? (request.user_metadata as Record<string, unknown>)
      : {};
  request.user_metadata = { ...metadata, project: costsProject };
  return new TextEncoder().encode(JSON.stringify(request));
}

/** The client config with JWT exchange switched off; anything unexpected passes through. */
export function withoutTinkerJwtAuth(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text;
    if (!parsed.pjwt_auth_enabled) return text;
    return JSON.stringify({ ...parsed, pjwt_auth_enabled: false });
  } catch {
    return text;
  }
}
