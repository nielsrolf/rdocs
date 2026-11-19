// Compute and storage providers behind the credential broker (2026-11-19):
// Hugging Face, RunPod and OpenWeights. (Tinker has its own file; Modal is NOT
// brokered, see the note at the end.)
//
// The pattern is the one GitHub uses (index.ts): the run env gets a virtual
// token plus the settings that point the provider's own client at
// /api/broker/<keyId>; the proxy adds the real credential outside the sandbox.
//
//   Hugging Face  HF_TOKEN = hf_rdocs-vk-…, HF_ENDPOINT = <key url>, and git
//                 configuration that sends https://huggingface.co/ there. One
//                 upstream host (huggingface.co). File bytes do not pass
//                 through here: the Hub answers with redirects to signed CDN
//                 URLs and with short-lived Xet tokens, which the client uses
//                 directly. Those are scoped to one repo and expire, which is
//                 the point of the exercise.
//   RunPod        RUNPOD_API_KEY = virtual, RUNPOD_API_BASE_URL = <key url>/api
//                 (GraphQL and the SDK's REST calls on api.runpod.io),
//                 RUNPOD_ENDPOINT_BASE_URL = <key url>/serverless
//                 (api.runpod.ai/v2), RUNPOD_REST_BASE_URL = <key url>/rest
//                 (rest.runpod.io/v1, for curl; no SDK reads that name).
//   OpenWeights   OPENWEIGHTS_API_KEY = ow_rdocs-vk-…, SUPABASE_URL = <key url>.
//                 The SDK swaps its API key for a Supabase JWT and then talks
//                 to Supabase with that. The proxy answers the swap itself:
//                 it gets the real JWT, keeps it, and hands the sandbox the
//                 virtual token again as "the JWT". Every later request
//                 carries the virtual token and leaves with the real JWT.
//
// What a virtual token cannot do: work anywhere but through this broker. Code
// that hard-codes a provider's host (https://huggingface.co/api/…) instead of
// honouring the client setting, and anything that copies the token to another
// machine (a job's environment on a remote worker, `ow env import`,
// `modal.Secret.from_local_environ`), gets a token the provider has never
// heard of. That is by design, and it is the visible cost of this feature.
//
// Modal is not here because its client speaks gRPC over HTTP/2 and sends the
// token id and secret as metadata on every call, to the control plane and to
// input-plane hosts the server names at run time. A Next.js route cannot proxy
// gRPC (no trailers), and a separate HTTP/2 proxy would also have to rewrite
// host names inside protobuf answers. Modal's token therefore still enters
// the sandbox; stored output is masked (lib/secret-redaction.ts).

export const HUGGINGFACE_PROVIDER = "huggingface";
export const RUNPOD_PROVIDER = "runpod";
export const OPENWEIGHTS_PROVIDER = "openweights";

export const HUGGINGFACE_DEFAULT_UPSTREAM = "https://huggingface.co";
export const RUNPOD_DEFAULT_UPSTREAM = "https://api.runpod.io";
export const OPENWEIGHTS_DEFAULT_SUPABASE_URL = "https://cmaguqyuzweixkrqjvnf.supabase.co";

/** Prefixes a provider's client insists on, which a virtual token therefore carries too. */
export const HUGGINGFACE_TOKEN_PREFIX = "hf_";
export const OPENWEIGHTS_TOKEN_PREFIX = "ow_";

/** Providers whose use is not spend: still served after a workspace budget is used up. */
export const NOT_SPEND_PROVIDERS = new Set(["github", HUGGINGFACE_PROVIDER]);

// --- RunPod -------------------------------------------------------------------

/**
 * Upstream for one part of a RunPod key. `base` is https://api.runpod.io in
 * production; anything else (a test double) is addressed by path on that host.
 */
export function runpodUpstream(base: string, segment: string): string | null {
  const root = base.replace(/\/+$/, "");
  const real = root === RUNPOD_DEFAULT_UPSTREAM;
  if (segment === "api") return real ? root : `${root}/api`;
  if (segment === "serverless") return real ? "https://api.runpod.ai/v2" : `${root}/serverless`;
  if (segment === "rest") return real ? "https://rest.runpod.io/v1" : `${root}/rest`;
  return null;
}

// --- Hugging Face ---------------------------------------------------------------

/**
 * git's smart-HTTP endpoints take the token as a Basic password (what
 * `git clone https://user:token@huggingface.co/…` sends); everything else on
 * the Hub, the LFS batch API included, takes it as a Bearer token.
 */
export function huggingfaceAuthHeader(pathSegments: string[], token: string): string {
  const last = pathSegments[pathSegments.length - 1] ?? "";
  const beforeLast = pathSegments[pathSegments.length - 2] ?? "";
  const gitProtocol =
    last === "git-upload-pack" || last === "git-receive-pack" || (beforeLast === "info" && last === "refs");
  return gitProtocol
    ? `Basic ${Buffer.from(`user:${token}`).toString("base64")}`
    : `Bearer ${token}`;
}

export function isHuggingfaceLfsBatch(method: string, pathSegments: string[]): boolean {
  const n = pathSegments.length;
  return (
    method.toUpperCase() === "POST" &&
    n >= 4 &&
    pathSegments[n - 1] === "batch" &&
    pathSegments[n - 2] === "objects" &&
    pathSegments[n - 3] === "lfs" &&
    pathSegments[n - 4] === "info"
  );
}

/**
 * Point a URL the Hub put in an answer back at this broker key when it leads
 * to the Hub itself: the client would otherwise send its (virtual) token
 * straight to huggingface.co. URLs of other hosts (signed CDN and storage
 * URLs) are returned unchanged; the client goes there directly, without a token.
 *
 * `keyPrefix` is "/api/broker/<id>" for a Location header (relative, right
 * for whatever address the client used) or "<origin>/api/broker/<id>" where
 * an absolute URL is needed.
 */
export function hubUrlViaBroker(url: string, upstreamBase: string, keyPrefix: string): string {
  const root = upstreamBase.replace(/\/+$/, "");
  if (url.startsWith("/") && !url.startsWith("//")) return `${keyPrefix}${url}`;
  if (url === root) return keyPrefix;
  if (url.startsWith(`${root}/`) || url.startsWith(`${root}?`)) return `${keyPrefix}${url.slice(root.length)}`;
  return url;
}

/** The LFS batch answer with every href that leads to the Hub pointed at the broker. */
export function rewriteLfsBatchHrefs(text: string, upstreamBase: string, absoluteKeyPrefix: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (key === "href" && typeof value === "string") {
        // A relative href would be resolved against the batch URL by the client; leave those.
        if (!value.startsWith("/")) record[key] = hubUrlViaBroker(value, upstreamBase, absoluteKeyPrefix);
      } else {
        visit(value);
      }
    }
  };
  visit(parsed);
  return JSON.stringify(parsed);
}

// --- OpenWeights ----------------------------------------------------------------

const endsWith = (pathSegments: string[], ...tail: string[]) =>
  tail.every((part, index) => pathSegments[pathSegments.length - tail.length + index] === part);

/** The SDK's swap of its API key for a Supabase JWT. */
export function isOpenweightsTokenExchange(method: string, pathSegments: string[]): boolean {
  return method.toUpperCase() === "POST" && endsWith(pathSegments, "rest", "v1", "rpc", "exchange_api_token_for_jwt");
}

/** The `api_token` of an exchange request body, or null. */
export function openweightsExchangeToken(body: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { api_token?: unknown };
    return typeof parsed?.api_token === "string" ? parsed.api_token.trim() : null;
  } catch {
    return null;
  }
}

/** Expiry (ms since epoch) of a JWT, or null when it cannot be read. */
export function jwtExpiryMs(jwt: string): number | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

// The real JWTs, per broker key, in this process only. Losing one (restart,
// the other blue/green process) costs one extra exchange. Never persisted.
type CachedJwt = { jwt: string; expiresAt: number };
const openweightsJwts = new Map<string, CachedJwt>();
const MAX_CACHED_JWTS = 500;
const JWT_SAFETY_MARGIN_MS = 60_000;
// Used when the JWT's own expiry cannot be read.
const JWT_FALLBACK_LIFETIME_MS = 10 * 60_000;

export function forgetOpenweightsJwt(keyId: string) {
  openweightsJwts.delete(keyId);
}

function rememberOpenweightsJwt(keyId: string, jwt: string, now: number) {
  const expiry = jwtExpiryMs(jwt);
  openweightsJwts.delete(keyId);
  openweightsJwts.set(keyId, { jwt, expiresAt: expiry ?? now + JWT_FALLBACK_LIFETIME_MS });
  while (openweightsJwts.size > MAX_CACHED_JWTS) {
    const oldest = openweightsJwts.keys().next().value;
    if (oldest === undefined) break;
    openweightsJwts.delete(oldest);
  }
}

export type OpenweightsJwtResult =
  | { ok: true; jwt: string }
  | { ok: false; status: number; body: string; contentType: string | null };

/**
 * The real Supabase JWT for a broker key: the cached one while it is good,
 * else a fresh exchange of the real API key. `anonKey` is the project's public
 * anon key, taken from the sandbox's own request (the `apikey` header every
 * Supabase call carries).
 */
export async function openweightsJwt(input: {
  keyId: string;
  upstreamBaseUrl: string;
  apiToken: string;
  anonKey: string | null;
  fresh?: boolean;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<OpenweightsJwtResult> {
  const now = input.now ?? Date.now();
  const cached = openweightsJwts.get(input.keyId);
  if (!input.fresh && cached && cached.expiresAt - JWT_SAFETY_MARGIN_MS > now) return { ok: true, jwt: cached.jwt };
  if (!input.anonKey) {
    return {
      ok: false,
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ message: "Credential broker: the request carries no Supabase `apikey` header." })
    };
  }
  const response = await (input.fetchImpl ?? fetch)(
    `${input.upstreamBaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/exchange_api_token_for_jwt`,
    {
      method: "POST",
      headers: {
        apikey: input.anonKey,
        authorization: `Bearer ${input.anonKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ api_token: input.apiToken }),
      redirect: "manual",
      cache: "no-store"
    }
  );
  const text = await response.text();
  let jwt: unknown = null;
  if (response.ok) {
    try {
      jwt = JSON.parse(text);
    } catch {
      jwt = null;
    }
  }
  if (typeof jwt !== "string" || !jwt) {
    forgetOpenweightsJwt(input.keyId);
    // The provider's own words (e.g. "API token has expired"): the SDK matches on them.
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      body: response.ok ? JSON.stringify({ message: "Credential broker: OpenWeights returned no JWT." }) : text,
      contentType: response.headers.get("content-type")
    };
  }
  rememberOpenweightsJwt(input.keyId, jwt, now);
  return { ok: true, jwt };
}
