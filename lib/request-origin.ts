// Resolve the externally-visible origin for building redirect/absolute URLs.
//
// SECURITY: x-forwarded-host / host are attacker-controllable. Using them
// unchecked turns redirect builders (share links, sign-out) into open redirects
// that can also leak share tokens to an attacker domain. We therefore only trust
// a forwarded host if it is explicitly allow-listed via APP_URL / ALLOWED_HOSTS,
// and otherwise fall back to the configured canonical origin.

function parseAllowedHosts(): { hosts: Set<string>; canonical: string | null } {
  const hosts = new Set<string>();
  let canonical: string | null = null;

  const appUrl = process.env.APP_URL?.trim();
  if (appUrl) {
    try {
      const url = new URL(appUrl);
      canonical = url.origin;
      hosts.add(url.host);
    } catch {
      // ignore malformed APP_URL
    }
  }

  const extra = process.env.ALLOWED_HOSTS?.trim();
  if (extra) {
    for (const host of extra.split(",").map((h) => h.trim()).filter(Boolean)) {
      hosts.add(host);
    }
  }

  return { hosts, canonical };
}

// Origin to trust for in-request redirects (sign-out, share-token landing).
// Keeps the user on whichever allow-listed host they actually arrived on so
// local dev redirects stay local; only falls back to canonical when the
// forwarded host isn't trusted.
function resolveRequestOrigin(headers: Headers, fallbackUrl?: string): string {
  const forwardedHost = headers.get("x-forwarded-host") ?? headers.get("host");
  const forwardedProto =
    headers.get("x-forwarded-proto") ??
    (fallbackUrl ? new URL(fallbackUrl).protocol.replace(":", "") : "https");

  const { hosts, canonical } = parseAllowedHosts();

  // Trust the forwarded host only when it matches the allow-list.
  if (forwardedHost && hosts.has(forwardedHost)) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  // No allow-list configured: fall back to the request's own origin (derived
  // from the URL Next.js resolved, not the spoofable header), then the host.
  if (hosts.size === 0) {
    if (fallbackUrl) {
      return new URL(fallbackUrl).origin;
    }
    if (forwardedHost) {
      return `${forwardedProto}://${forwardedHost}`;
    }
  }

  // Allow-list configured but the forwarded host didn't match — use canonical.
  return canonical ?? (fallbackUrl ? new URL(fallbackUrl).origin : "");
}

export function getRequestOrigin(request: Request): string {
  return resolveRequestOrigin(request.headers, request.url);
}

// Canonical public origin for absolute URLs that get shared/sent out of band
// (share links, invites). Unlike getRequestOrigin this prefers the configured
// APP_URL over the request's host, so links always point at the public domain
// (e.g. https://docs.nielsrolf.com) even when the page was opened on localhost.
// Falls back to the request origin when APP_URL is not configured.
export function getPublicOrigin(headers: Headers, fallbackUrl?: string): string {
  const { canonical } = parseAllowedHosts();
  if (canonical) {
    return canonical;
  }
  return resolveRequestOrigin(headers, fallbackUrl);
}
