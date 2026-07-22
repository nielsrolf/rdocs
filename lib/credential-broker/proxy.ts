import { resolveBrokerRequest } from "./index";

// The HTTP half of the credential broker: validates the virtual token carried
// in the incoming request's auth header, swaps in the real credential, and
// streams the upstream response back. Kept out of the Next route file so tests
// can exercise it with plain Request objects against a local fake upstream.

// Request headers never forwarded upstream: connection/transport internals,
// the incoming auth material (replaced per authMode), and every proxy /
// Cloudflare breadcrumb — the upstream should see a clean direct client.
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "keep-alive",
  "upgrade",
  "expect",
  "authorization",
  "x-api-key",
  "cookie",
  "cdn-loop",
  "x-real-ip"
]);

// Response headers dropped: fetch() has already decoded the body, so the
// original framing/encoding headers would corrupt the re-stream.
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive"
]);

function isFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * The broker is meant for the deployment's own agent containers, which reach
 * it directly (host.docker.internal / loopback → Caddy). Public traffic
 * arrives through the Cloudflare tunnel and carries CF headers — reject it
 * unless BROKER_ALLOW_PUBLIC is set (future: self-hosted workers).
 */
export function isPublicBrokerRequest(headers: Headers): boolean {
  return Boolean(headers.get("cf-ray") || headers.get("cf-connecting-ip"));
}

export function extractPresentedToken(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  const apiKey = headers.get("x-api-key");
  return apiKey ? apiKey.trim() : null;
}

export async function handleBrokerProxyRequest(
  request: Request,
  keyId: string,
  pathSegments: string[],
  opts: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch } = {}
): Promise<Response> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const startedAt = Date.now();

  if (isPublicBrokerRequest(request.headers) && !isFlagEnabled(env.BROKER_ALLOW_PUBLIC)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const presented = extractPresentedToken(request.headers);
  const resolution = await resolveBrokerRequest(keyId, presented);
  if (!resolution.ok) {
    console.warn(
      `[broker] rejected ${request.method} key=${keyId} path=/${pathSegments.join("/")}: ${resolution.error}`
    );
    return Response.json(
      { error: `Credential broker: ${resolution.error}` },
      { status: resolution.status }
    );
  }

  const incomingUrl = new URL(request.url);
  const upstreamUrl = `${resolution.upstreamBaseUrl}/${pathSegments
    .map(encodeURIComponent)
    .join("/")}${incomingUrl.search}`;

  const headers = new Headers();
  request.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(lower)) return;
    if (lower.startsWith("cf-") || lower.startsWith("x-forwarded-")) return;
    headers.set(name, value);
  });
  if (resolution.authMode === "x-api-key") {
    headers.set("x-api-key", resolution.secretValue);
  } else {
    headers.set("authorization", `Bearer ${resolution.secretValue}`);
  }

  const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase());
  let upstream: Response;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      // Never follow a redirect: it could re-send the real credential to a
      // host we did not vet. The client sees the redirect status as-is.
      redirect: "manual",
      cache: "no-store",
      // @ts-expect-error - undici needs duplex for streamed request bodies.
      duplex: hasBody ? "half" : undefined
    });
  } catch (error) {
    console.warn(
      `[broker] upstream fetch failed key=${keyId} provider=${resolution.provider}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return Response.json({ error: "Credential broker: upstream unreachable." }, { status: 502 });
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    if (STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) return;
    responseHeaders.set(name, value);
  });

  console.log(
    `[broker] ${request.method} ${resolution.provider}/${pathSegments.join("/")} -> ${upstream.status} (${
      Date.now() - startedAt
    }ms) run=${resolution.aiRunId ?? "-"} key=${keyId}`
  );

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}
