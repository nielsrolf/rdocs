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

export function getRequestOrigin(request: Request): string {
  const headers = request.headers;
  const forwardedHost = headers.get("x-forwarded-host") ?? headers.get("host");
  const forwardedProto =
    headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");

  const { hosts, canonical } = parseAllowedHosts();

  // Trust the forwarded host only when it matches the allow-list.
  if (forwardedHost && hosts.has(forwardedHost)) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  // No allow-list configured: fall back to the request's own origin (derived
  // from the URL Next.js resolved, not the spoofable header).
  if (hosts.size === 0) {
    return new URL(request.url).origin;
  }

  // Allow-list configured but the forwarded host didn't match — use canonical.
  return canonical ?? new URL(request.url).origin;
}
