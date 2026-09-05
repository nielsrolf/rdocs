import { NextResponse } from "next/server";
import { z } from "zod";

import {
  McpServerValidationError,
  deleteDocumentMcpServer,
  listDocumentMcpServers,
  listInheritedMcpServers,
  upsertDocumentMcpServer
} from "@/lib/document-mcp-servers";
import { requireDocumentAccess } from "@/lib/api-helpers";

export const runtime = "nodejs";

const upsertSchema = z.object({
  name: z.string().min(1).max(64),
  url: z.string().min(1).max(2000),
  authEnvKey: z.string().max(128).optional().nullable(),
  shareToken: z.string().optional().nullable()
});
const deleteSchema = z.object({ name: z.string().min(1).max(64), shareToken: z.string().optional().nullable() });

const forbiddenMessage = "You need edit access to manage this document's MCP servers.";

async function access(request: Request, id: string, bodyShareToken?: string | null) {
  const shareToken = bodyShareToken ?? new URL(request.url).searchParams.get("share");
  return requireDocumentAccess(request, id, "EDIT", { shareToken, requireUser: true, forbiddenMessage });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await access(request, id);
  if (!auth.ok) return auth.response;
  // `inherited`: workspace-owning document's servers (shared workspace) and the
  // viewer's personal servers, shown read-only so a run's tool set is explainable.
  return NextResponse.json({
    servers: await listDocumentMcpServers(id),
    inherited: await listInheritedMcpServers(id, auth.user?.id ?? null)
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = upsertSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid MCP server payload." }, { status: 400 });
  const auth = await access(request, id, parsed.data.shareToken);
  if (!auth.ok) return auth.response;
  try {
    const { shareToken: _shareToken, ...server } = parsed.data;
    const servers = await upsertDocumentMcpServer({ documentId: id, ...server });
    return NextResponse.json({ servers });
  } catch (error) {
    if (error instanceof McpServerValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid MCP server payload." }, { status: 400 });
  const auth = await access(request, id, parsed.data.shareToken);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ servers: await deleteDocumentMcpServer(id, parsed.data.name) });
}
