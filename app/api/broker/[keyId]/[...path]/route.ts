import { handleBrokerProxyRequest } from "@/lib/credential-broker/proxy";

// Agent credential broker endpoint. Agent runs receive per-run VIRTUAL tokens
// plus *_BASE_URL overrides pointing here (see lib/credential-broker); this
// route swaps the virtual token for the real credential and streams the
// upstream response back. Auth is the virtual token itself (hash-checked,
// run-liveness-checked per request); Cloudflare-originated (public) traffic is
// rejected outright.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ keyId: string; path: string[] }>;
};

async function handle(request: Request, { params }: RouteContext) {
  const { keyId, path } = await params;
  return handleBrokerProxyRequest(request, keyId, path ?? []);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
