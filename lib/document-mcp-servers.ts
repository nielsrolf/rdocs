import {
  isValidMcpServerName,
  isValidMcpServerUrl,
  type AgentMcpServerInput
} from "@/agent-core/mcp-servers";
import { isValidEnvKey, type DocumentEnv } from "@/lib/agent-env";
import { db } from "@/lib/db";

export type DocumentMcpServerRecord = {
  id: string;
  name: string;
  url: string;
  authEnvKey: string | null;
  createdAt: string;
};

export const MAX_MCP_SERVERS_PER_DOCUMENT = 10;

function serialize(row: { id: string; name: string; url: string; authEnvKey: string | null; createdAt: Date }) {
  return { id: row.id, name: row.name, url: row.url, authEnvKey: row.authEnvKey, createdAt: row.createdAt.toISOString() };
}

export async function listDocumentMcpServers(documentId: string): Promise<DocumentMcpServerRecord[]> {
  const rows = await db.documentMcpServer.findMany({ where: { documentId }, orderBy: { createdAt: "asc" } });
  return rows.map(serialize);
}

export class McpServerValidationError extends Error {}

export function validateMcpServerInput(input: { name: string; url: string; authEnvKey?: string | null }) {
  const name = input.name.trim();
  const url = input.url.trim();
  const authEnvKey = input.authEnvKey?.trim() || null;
  if (!isValidMcpServerName(name)) {
    throw new McpServerValidationError(
      "Server name must be lowercase letters, digits, '-' or '_' (max 32 chars) and not 'gdocs' or 'rdocs'."
    );
  }
  if (!isValidMcpServerUrl(url)) throw new McpServerValidationError("Server URL must be http(s).");
  if (authEnvKey && !isValidEnvKey(authEnvKey)) {
    throw new McpServerValidationError("Auth env key must be a valid environment variable name.");
  }
  return { name, url, authEnvKey };
}

/** Create or replace the server with this name. */
export async function upsertDocumentMcpServer(args: {
  documentId: string;
  name: string;
  url: string;
  authEnvKey?: string | null;
}): Promise<DocumentMcpServerRecord[]> {
  const { name, url, authEnvKey } = validateMcpServerInput(args);
  const count = await db.documentMcpServer.count({ where: { documentId: args.documentId, NOT: { name } } });
  if (count >= MAX_MCP_SERVERS_PER_DOCUMENT) {
    throw new McpServerValidationError(`At most ${MAX_MCP_SERVERS_PER_DOCUMENT} MCP servers per document.`);
  }
  await db.documentMcpServer.upsert({
    where: { documentId_name: { documentId: args.documentId, name } },
    create: { documentId: args.documentId, name, url, authEnvKey },
    update: { url, authEnvKey }
  });
  return listDocumentMcpServers(args.documentId);
}

export async function deleteDocumentMcpServer(documentId: string, name: string): Promise<DocumentMcpServerRecord[]> {
  await db.documentMcpServer.deleteMany({ where: { documentId, name } });
  return listDocumentMcpServers(documentId);
}

/**
 * Turn stored rows into run inputs. The bearer value is read from the run's
 * resolved env (plaintext document env + account credentials), so the secret
 * itself is never stored on the server row. A server whose auth key is
 * configured but absent from the env is skipped with a warning rather than
 * mounted unauthenticated.
 */
export function resolveMcpServerInputs(
  servers: Array<Pick<DocumentMcpServerRecord, "name" | "url" | "authEnvKey">>,
  env: DocumentEnv,
  log: (message: string, data: Record<string, unknown>) => void = (message, data) =>
    console.warn(`[mcp-servers] ${message}`, data)
): AgentMcpServerInput[] {
  const out: AgentMcpServerInput[] = [];
  for (const server of servers) {
    if (server.authEnvKey) {
      const value = env[server.authEnvKey]?.trim();
      if (!value) {
        log("skipping MCP server: auth env var is not set", { name: server.name, authEnvKey: server.authEnvKey });
        continue;
      }
      out.push({ name: server.name, url: server.url, headers: { Authorization: `Bearer ${value}` } });
    } else {
      out.push({ name: server.name, url: server.url });
    }
  }
  return out;
}

export async function loadDocumentMcpServerInputs(documentId: string, env: DocumentEnv): Promise<AgentMcpServerInput[]> {
  const servers = await listDocumentMcpServers(documentId);
  if (servers.length === 0) return [];
  return resolveMcpServerInputs(servers, env);
}
