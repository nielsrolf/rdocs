import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import {
  McpServerValidationError,
  deleteUserMcpServer,
  listUserMcpServers,
  upsertUserMcpServer
} from "@/lib/document-mcp-servers";

export const runtime = "nodejs";

// Personal MCP servers (UserMcpServer): mounted into every agent run this user
// triggers, below document/workspace servers of the same name. The bearer
// token is write-only — stored encrypted, reported back only as `hasAuthToken`.

const upsertSchema = z.object({
  name: z.string().min(1).max(64),
  url: z.string().min(1).max(2000),
  // string = set, null = clear, absent = keep the stored token.
  authToken: z.string().max(4096).optional().nullable()
});
const deleteSchema = z.object({ name: z.string().min(1).max(64) });

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  return NextResponse.json({ servers: await listUserMcpServers(user.id) });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const parsed = upsertSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid MCP server payload." }, { status: 400 });
  try {
    const servers = await upsertUserMcpServer({ userId: user.id, ...parsed.data });
    return NextResponse.json({ servers });
  } catch (error) {
    if (error instanceof McpServerValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid MCP server payload." }, { status: 400 });
  return NextResponse.json({ servers: await deleteUserMcpServer(user.id, parsed.data.name) });
}
