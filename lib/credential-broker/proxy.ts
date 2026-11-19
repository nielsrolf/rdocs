import { GITHUB_PROVIDER, githubUpstream, isVirtualBrokerToken, resolveBrokerRequest } from "./index";
import { randomUUID } from "node:crypto";
import {
  isTinkerClientConfig,
  isTinkerCreateSession,
  tagTinkerSession,
  TINKER_PROVIDER,
  withoutTinkerJwtAuth
} from "./tinker";
import { createUsageCapture, type BrokerUsage } from "./usage";

// Providers whose responses carry model usage worth recording per call. Compute
// providers (Tinker) make thousands of requests per run that are not model calls.
const USAGE_PROVIDERS = new Set(["anthropic", "openai", "openrouter", "litellm"]);

/** What the workspace budget says about a run (lib/workspace-budget.ts). */
export type RunBudgetState = { costsProject: string | null; exhausted: boolean };

async function defaultRunBudget(aiRunId: string): Promise<RunBudgetState> {
  const { runBudgetState } = await import("@/lib/workspace-budget-state");
  return runBudgetState(aiRunId);
}

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
    // "Bearer <t>" (most clients, git's extraheader) and "token <t>" (gh, older GitHub clients).
    const match = /^(?:Bearer|token)\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
    // "Basic user:pass" (curl -u, git credential helpers): whichever half is the virtual token.
    const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(auth.trim());
    if (basic) {
      const decoded = Buffer.from(basic[1], "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      const parts = colon === -1 ? [decoded] : [decoded.slice(colon + 1), decoded.slice(0, colon)];
      const virtual = parts.find((part) => isVirtualBrokerToken(part));
      if (virtual) return virtual;
    }
  }
  const apiKey = headers.get("x-api-key");
  return apiKey ? apiKey.trim() : null;
}

// Set by the in-sandbox gh bridge (agent-core/github-broker-bridge.ts), whose
// client follows absolute GitHub URLs through the bridge by itself.
const GITHUB_FORWARDER_HEADER = "x-rdocs-github-forwarder";

/**
 * Point a GitHub URL found in a response (a redirect, a pagination link) back
 * at this broker key, so the client's next request is authenticated too
 * instead of going to GitHub directly with a token GitHub does not know.
 */
function githubUrlViaBroker(url: string, upstreamBase: string, keyPrefix: string): string {
  for (const segment of ["api", "uploads", "raw", "git"]) {
    const target = githubUpstream(upstreamBase, segment)!.baseUrl;
    if (url === target || url.startsWith(`${target}/`) || url.startsWith(`${target}?`)) {
      return `${keyPrefix}/${segment}${url.slice(target.length)}`;
    }
  }
  return url;
}

export async function handleBrokerProxyRequest(
  request: Request,
  keyId: string,
  pathSegments: string[],
  opts: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch;
    onUsage?: (aiRunId: string, usage: BrokerUsage) => Promise<void>;
    runBudget?: (aiRunId: string) => Promise<RunBudgetState> } = {}
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

  const isGithubKey = resolution.provider === GITHUB_PROVIDER;
  // A run of a workspace with a budget: nothing more is spent once it is used up.
  let budget: RunBudgetState = { costsProject: null, exhausted: false };
  if (resolution.aiRunId) {
    try {
      budget = await (opts.runBudget ?? defaultRunBudget)(resolution.aiRunId);
    } catch (error) {
      console.warn("[broker] budget lookup failed", { aiRunId: resolution.aiRunId, error: String(error) });
    }
  }
  // GitHub is not spend: a run whose budget ran out must still be able to push what it has.
  if (budget.exhausted && !isGithubKey) {
    console.warn(`[broker] refused ${resolution.provider} for run ${resolution.aiRunId}: budget of ${budget.costsProject} is used up`);
    return Response.json(
      {
        error: {
          type: "budget_exhausted",
          message:
            "This workspace's compute budget is used up, so r-docs no longer forwards requests to " +
            `${resolution.provider}. Stop and report what you have; the budget can only be raised by the workspace that gave it.`
        }
      },
      { status: 402 }
    );
  }

  const incomingUrl = new URL(request.url);
  // A GitHub key fronts several hosts; the first path segment picks one.
  const isGithub = isGithubKey;
  let upstreamBase = resolution.upstreamBaseUrl;
  let upstreamSegments = pathSegments;
  let githubAuth: "basic" | "bearer" = "bearer";
  if (isGithub) {
    const target = githubUpstream(resolution.upstreamBaseUrl, pathSegments[0] ?? "");
    if (!target) {
      return Response.json(
        { error: "Credential broker: unknown GitHub endpoint. Use /git, /api, /uploads or /raw." },
        { status: 404 }
      );
    }
    upstreamBase = target.baseUrl;
    upstreamSegments = pathSegments.slice(1);
    githubAuth = target.auth;
  }
  const upstreamUrl = `${upstreamBase}/${upstreamSegments
    .map(encodeURIComponent)
    .join("/")}${incomingUrl.search}`;

  const headers = new Headers();
  request.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(lower)) return;
    if (lower.startsWith("cf-") || lower.startsWith("x-forwarded-")) return;
    headers.set(name, value);
  });
  if (isGithub) {
    headers.delete(GITHUB_FORWARDER_HEADER);
    headers.set(
      "authorization",
      githubAuth === "basic"
        ? `Basic ${Buffer.from(`x-access-token:${resolution.secretValue}`).toString("base64")}`
        : `Bearer ${resolution.secretValue}`
    );
  } else if (resolution.authMode === "x-api-key") {
    headers.set("x-api-key", resolution.secretValue);
  } else {
    headers.set("authorization", `Bearer ${resolution.secretValue}`);
  }

  const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase());
  let upstream: Response;
  try {
    // Buffer once at the trust boundary. Forwarding Next's incoming stream
    // makes undici use chunked transfer encoding; some OpenAI-compatible
    // Responses endpoints reject that even though their JSON payload is valid.
    // Exception: git packs and release uploads can be gigabytes, and GitHub
    // accepts a streamed body, so those are passed through as they arrive.
    const streamBody = isGithub && hasBody && pathSegments[0] !== "api" && request.body !== null;
    if (streamBody) {
      upstream = await fetchImpl(upstreamUrl, {
        method: request.method,
        headers,
        body: request.body,
        duplex: "half",
        redirect: "manual",
        cache: "no-store"
      } as RequestInit);
    } else {
    let body = hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined;
    if (body && budget.costsProject && resolution.provider === TINKER_PROVIDER && isTinkerCreateSession(request.method, pathSegments)) {
      body = tagTinkerSession(body, budget.costsProject);
    }
    if (body) headers.set("content-length", String(body.byteLength));
    upstream = await fetchImpl(upstreamUrl, {
      method: request.method,
      headers,
      body,
      // Never follow a redirect: it could re-send the real credential to a
      // host we did not vet. The client sees the redirect status as-is.
      redirect: "manual",
      cache: "no-store",
    });
    }
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

  if (isGithub) {
    // Relative, so it is right whatever address the client used to reach us.
    const keyPrefix = `/api/broker/${keyId}`;
    const location = responseHeaders.get("location");
    if (location) responseHeaders.set("location", githubUrlViaBroker(location, resolution.upstreamBaseUrl, keyPrefix));
    const link = responseHeaders.get("link");
    if (link && !request.headers.get(GITHUB_FORWARDER_HEADER)) {
      const origin = (env.AGENT_BROKER_BASE_URL?.trim() || incomingUrl.origin).replace(/\/+$/, "");
      responseHeaders.set(
        "link",
        link.replace(/<([^>]+)>/g, (_match, url: string) =>
          `<${githubUrlViaBroker(url, resolution.upstreamBaseUrl, `${origin}${keyPrefix}`)}>`)
      );
    }
    // GitHub's session cookies have no business in an agent's client.
    responseHeaders.delete("set-cookie");
  }

  console.log(
    `[broker] ${request.method} ${resolution.provider}/${pathSegments.join("/")} -> ${upstream.status} (${
      Date.now() - startedAt
    }ms) run=${resolution.aiRunId ?? "-"} key=${keyId}`
  );

  if (resolution.provider === TINKER_PROVIDER && upstream.ok && isTinkerClientConfig(pathSegments)) {
    return new Response(withoutTinkerJwtAuth(await upstream.text()), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    });
  }

  let responseBody = upstream.body;
  if (responseBody && resolution.aiRunId && USAGE_PROVIDERS.has(resolution.provider)) {
    const rawCost = upstream.headers.get("x-litellm-response-cost");
    const cost = rawCost === null ? NaN : Number(rawCost);
    const capture = createUsageCapture({ requestId: randomUUID(), provider: resolution.provider,
      costUsd: Number.isFinite(cost) && cost >= 0 ? cost : null,
      // Anthropic directly: a bearer token is a Claude subscription login, x-api-key an API key.
      ...(resolution.provider === "anthropic"
        ? { billing: resolution.authMode === "authorization-bearer" ? "subscription" as const : "api-key" as const }
        : {}) });
    const decoder = new TextDecoder();
    const reader = responseBody.getReader();
    const aiRunId = resolution.aiRunId;
    let recorded = false;
    const finish = async (complete: boolean) => {
      if (recorded) return;
      recorded = true;
      capture.push(decoder.decode());
      const usage = capture.finish(complete);
      try {
        if (opts.onUsage) await opts.onUsage(aiRunId, usage);
        else {
          const { db } = await import("@/lib/db");
          await db.aiRunEvent.create({ data: { aiRunId, role: "system", message: `[usage] ${JSON.stringify(usage)}` } });
        }
      } catch (error) {
        console.warn("[broker] usage persistence failed", { aiRunId, error: String(error) });
      }
    };
    responseBody = new ReadableStream<Uint8Array<ArrayBuffer>>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { await finish(true); controller.close(); return; }
          capture.push(decoder.decode(value, { stream: true }));
          controller.enqueue(value);
        } catch (error) { await finish(false); controller.error(error); }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { await finish(false); } }
    });
  }
  return new Response(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}
