// Run-scoped token that lets a HEADLESS document run (an API-channel run or a
// scheduled document task) edit its own document through the rdocs MCP bridge
// (/api/mcp). Nobody has the document open when such a run finishes, so the
// suggestions array of a conversation run would never be applied; the bridge
// applies edits server-side through the collaboration pipeline instead.
//
// The token acts as the run's user (the channel creator / task scheduler) but
// is confined to ONE document: lib/mcp/tools.ts refuses any other document and
// the tools that roam across documents. Same SESSION_SECRET as the Slack run
// tokens; deliberately free of next/headers so headless tests can use it.

import { SignJWT, jwtVerify } from "jose";

import type { AgentMcpServerInput } from "@/agent-core/mcp-servers";

const PURPOSE = "document-run-mcp";
const encoder = new TextEncoder();

/** Name the bridge is mounted under in headless runs: tools are `mcp__doc__*`. */
export const DOCUMENT_BRIDGE_SERVER_NAME = "doc";

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required.");
  }
  return encoder.encode(secret);
}

export type DocumentRunClaims = {
  userId: string;
  documentId: string;
  aiRunId: string;
};

export async function createDocumentRunToken(claims: DocumentRunClaims) {
  return new SignJWT({ purpose: PURPOSE, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(getSecret());
}

export async function verifyDocumentRunToken(token: string): Promise<DocumentRunClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (
      payload.purpose !== PURPOSE ||
      typeof payload.userId !== "string" ||
      typeof payload.documentId !== "string" ||
      typeof payload.aiRunId !== "string"
    ) {
      return null;
    }
    return { userId: payload.userId, documentId: payload.documentId, aiRunId: payload.aiRunId };
  } catch {
    return null;
  }
}

/** Where agent containers reach /api/mcp (same override as Slack runs). */
export function documentBridgeUrl(): string {
  const override = process.env.SLACK_AGENT_MCP_URL?.trim();
  if (override) return override;
  const appUrl = (process.env.APP_URL ?? "http://localhost:14141").trim().replace(/\/$/, "");
  return `${appUrl}/api/mcp`;
}

/**
 * The bridge as a per-run MCP server, merged in front of the run's other
 * servers. A run server the integration passed under the same name wins.
 */
export async function withDocumentBridge(
  servers: AgentMcpServerInput[] | undefined,
  claims: DocumentRunClaims
): Promise<AgentMcpServerInput[]> {
  const existing = servers ?? [];
  if (existing.some((server) => server.name === DOCUMENT_BRIDGE_SERVER_NAME)) return existing;
  const token = await createDocumentRunToken(claims);
  return [
    ...existing,
    {
      name: DOCUMENT_BRIDGE_SERVER_NAME,
      url: documentBridgeUrl(),
      headers: { Authorization: `Bearer ${token}` }
    }
  ];
}

/**
 * Prepended to the message of a headless run so the agent knows its changes
 * must go through the bridge (the run's system prompt still describes the
 * interactive suggestions flow).
 */
export function headlessEditNote(documentId: string): string {
  return (
    `[Headless run: nobody has this document open, so suggestions you return are NOT applied. ` +
    `To change the document, use the mcp__${DOCUMENT_BRIDGE_SERVER_NAME}__* tools on document "${documentId}" ` +
    `(read_document, replace_in_document, replace_document, append_to_document, create_widget, upload_files) — ` +
    `they apply immediately. Leave the document unchanged when the instruction does not call for edits.]`
  );
}
