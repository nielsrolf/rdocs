import { NextResponse } from "next/server";
import { z } from "zod";

import { createApiToken, listApiTokens, revokeApiToken } from "@/lib/api-tokens";
import { getCurrentUser } from "@/lib/auth";
import { getPublicOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

// Personal MCP access tokens ("Connect via MCP" in the account menu). POST
// returns the plaintext token and the ready-to-paste `claude mcp add` command
// exactly once; afterwards tokens are listed by label/timestamps only.

function buildConnectCommand(origin: string, token: string) {
  return `claude mcp add --transport http gdocs-ai ${origin}/api/mcp --header "Authorization: Bearer ${token}"`;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  return NextResponse.json({ tokens: await listApiTokens(user.id) });
}

const createSchema = z.object({ label: z.string().max(120).optional() });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  const { token, record } = await createApiToken(user.id, parsed.data.label ?? null);
  const origin = getPublicOrigin(request.headers);
  return NextResponse.json({
    token,
    command: buildConnectCommand(origin, token),
    record,
    tokens: await listApiTokens(user.id)
  });
}

const deleteSchema = z.object({ id: z.string().min(1) });

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }
  const revoked = await revokeApiToken(user.id, parsed.data.id);
  if (!revoked) {
    return NextResponse.json({ error: "Token not found." }, { status: 404 });
  }
  return NextResponse.json({ tokens: await listApiTokens(user.id) });
}
