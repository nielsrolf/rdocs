import { NextResponse } from "next/server";

import { resolveApiTokenUser } from "@/lib/api-tokens";
import { handleMcpBody } from "@/lib/mcp/server";
import { getPublicOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";
// Long agent-driven tool calls (widget builds, git pushes) can take a while.
export const maxDuration = 90;

// MCP endpoint for external agents (Claude Code etc.), streamable-HTTP
// transport in stateless plain-JSON mode. Authenticated with a personal API
// token (see the "Connect via MCP" section of the account menu):
//
//   claude mcp add --transport http gdocs-ai <origin>/api/mcp \
//     --header "Authorization: Bearer gdai_…"

function unauthorized() {
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Invalid or missing API token." } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
  );
}

export async function POST(request: Request) {
  const user = await resolveApiTokenUser(request.headers.get("authorization"));
  if (!user) {
    return unauthorized();
  }

  const body = await request.json().catch(() => null);
  if (body === null) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } },
      { status: 400 }
    );
  }

  const origin = getPublicOrigin(request.headers);
  const { status, payload } = await handleMcpBody(body, { user, origin });
  if (payload === null) {
    return new Response(null, { status });
  }
  return NextResponse.json(payload, { status });
}

// The streamable HTTP transport allows servers to reject GET (no
// server-initiated stream support).
export async function GET() {
  return NextResponse.json({ error: "This MCP server does not support server-initiated streams." }, { status: 405 });
}

export async function DELETE() {
  // Stateless server: nothing to terminate.
  return new Response(null, { status: 200 });
}
