import {
  isValidMcpServerName,
  isValidMcpServerUrl,
  type AgentMcpServerInput
} from "@/agent-core/mcp-servers";
import { isValidEnvKey, type DocumentEnv } from "@/lib/agent-env";
import { db } from "@/lib/db";
import { loadDocumentEnv } from "@/lib/document-env";
import { resolveWorkspaceDocumentId } from "@/lib/research-workspace";
import { decryptSecret, encryptSecret } from "@/lib/secret-crypto";

export type DocumentMcpServerRecord = {
  id: string;
  name: string;
  url: string;
  authEnvKey: string | null;
  createdAt: string;
};

export const MAX_MCP_SERVERS_PER_DOCUMENT = 10;
export const MAX_MCP_SERVERS_PER_USER = 10;
/** Cap on servers an API caller may attach to ONE run. */
export const MAX_MCP_SERVERS_PER_RUN = 10;

/** Where a server that applies to a run comes from; also the precedence order (first wins on a name clash). */
export type McpServerScope = "run" | "document" | "workspace" | "user";
export const MCP_SERVER_SCOPE_PRECEDENCE: readonly McpServerScope[] = ["run", "document", "workspace", "user"];

export type UserMcpServerRecord = {
  id: string;
  name: string;
  url: string;
  /** Whether a bearer token is stored; the token itself is never returned. */
  hasAuthToken: boolean;
  createdAt: string;
};

/** A server the environment menu shows as inherited (read-only there). */
export type InheritedMcpServer = { name: string; url: string; scope: "workspace" | "user"; shadowed: boolean };

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

// ---------------------------------------------------------------------------
// User-scoped servers (Settings → AI → "Your MCP servers").

function serializeUserServer(row: { id: string; name: string; url: string; authToken: string | null; createdAt: Date }) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    hasAuthToken: Boolean(row.authToken),
    createdAt: row.createdAt.toISOString()
  };
}

export async function listUserMcpServers(userId: string): Promise<UserMcpServerRecord[]> {
  const rows = await db.userMcpServer.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  return rows.map(serializeUserServer);
}

/**
 * Create or replace the user's server with this name. `authToken` semantics:
 * a string stores (encrypted) that bearer token, `null` clears it, `undefined`
 * keeps whatever is stored — so re-saving a URL never silently drops the token.
 */
export async function upsertUserMcpServer(args: {
  userId: string;
  name: string;
  url: string;
  authToken?: string | null;
}): Promise<UserMcpServerRecord[]> {
  const { name, url } = validateMcpServerInput({ name: args.name, url: args.url });
  const token = args.authToken === undefined ? undefined : args.authToken?.trim() || null;
  if (token && token.length > 4096) throw new McpServerValidationError("Bearer token is too long.");
  const count = await db.userMcpServer.count({ where: { userId: args.userId, NOT: { name } } });
  if (count >= MAX_MCP_SERVERS_PER_USER) {
    throw new McpServerValidationError(`At most ${MAX_MCP_SERVERS_PER_USER} personal MCP servers.`);
  }
  const encrypted = token === undefined ? undefined : token ? encryptSecret(token) : null;
  await db.userMcpServer.upsert({
    where: { userId_name: { userId: args.userId, name } },
    create: { userId: args.userId, name, url, authToken: encrypted ?? null },
    update: { url, ...(encrypted === undefined ? {} : { authToken: encrypted }) }
  });
  return listUserMcpServers(args.userId);
}

export async function deleteUserMcpServer(userId: string, name: string): Promise<UserMcpServerRecord[]> {
  await db.userMcpServer.deleteMany({ where: { userId, name } });
  return listUserMcpServers(userId);
}

async function loadUserMcpServerInputs(userId: string): Promise<AgentMcpServerInput[]> {
  const rows = await db.userMcpServer.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  const out: AgentMcpServerInput[] = [];
  for (const row of rows) {
    if (!row.authToken) {
      out.push({ name: row.name, url: row.url });
      continue;
    }
    try {
      out.push({ name: row.name, url: row.url, headers: { Authorization: `Bearer ${decryptSecret(row.authToken)}` } });
    } catch (error) {
      console.warn("[mcp-servers] skipping user MCP server: stored token cannot be decrypted", {
        userId,
        name: row.name,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-run resolution across all scopes.

/** A server supplied by an API caller for one run only. Never persisted. */
export type RunMcpServerInput = {
  name: string;
  url: string;
  /** Sent as `Authorization: Bearer <authToken>`. */
  authToken?: string | null;
  /** Arbitrary extra request headers (an explicit Authorization header wins over authToken). */
  headers?: Record<string, string> | null;
};

/** Validate and normalize API-supplied servers into run inputs. Throws McpServerValidationError. */
export function resolveRunMcpServerInputs(servers: RunMcpServerInput[] | null | undefined): AgentMcpServerInput[] {
  if (!servers || servers.length === 0) return [];
  if (servers.length > MAX_MCP_SERVERS_PER_RUN) {
    throw new McpServerValidationError(`At most ${MAX_MCP_SERVERS_PER_RUN} MCP servers per run.`);
  }
  const seen = new Set<string>();
  const out: AgentMcpServerInput[] = [];
  for (const server of servers) {
    const { name, url } = validateMcpServerInput({ name: server.name, url: server.url });
    if (seen.has(name)) throw new McpServerValidationError(`Duplicate MCP server name: ${name}.`);
    seen.add(name);
    const headers: Record<string, string> = {};
    const token = server.authToken?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    for (const [key, value] of Object.entries(server.headers ?? {})) {
      if (!/^[A-Za-z0-9-]{1,128}$/.test(key) || typeof value !== "string" || /[\r\n]/.test(value)) {
        throw new McpServerValidationError(`Invalid header on MCP server ${name}.`);
      }
      headers[key] = value;
    }
    out.push(Object.keys(headers).length > 0 ? { name, url, headers } : { name, url });
  }
  return out;
}

/**
 * Merge servers from several scopes into one list. Scopes are visited in
 * MCP_SERVER_SCOPE_PRECEDENCE order and the first server of a given name wins,
 * so a document can override a workspace server, which can override a personal
 * one, and an API caller's per-run server overrides everything.
 */
export function mergeMcpServerInputs(
  byScope: Partial<Record<McpServerScope, AgentMcpServerInput[]>>
): AgentMcpServerInput[] {
  const seen = new Set<string>();
  const out: AgentMcpServerInput[] = [];
  for (const scope of MCP_SERVER_SCOPE_PRECEDENCE) {
    for (const server of byScope[scope] ?? []) {
      if (seen.has(server.name)) continue;
      seen.add(server.name);
      out.push(server);
    }
  }
  return out;
}

/**
 * Everything an agent run of `documentId` triggered by `userId` should mount:
 * per-run servers (API callers), the document's own servers, the servers of the
 * workspace-owning document when this document shares another document's
 * workspace (the workspace scope), and the triggering user's personal servers.
 *
 * `env` is the run's resolved env (document env + injected account keys) and is
 * what `authEnvKey`s of document servers resolve against; inherited workspace
 * servers additionally fall back to the workspace document's own env, since
 * that is where their operator put the key.
 */
export async function loadRunMcpServerInputs(args: {
  documentId: string;
  userId?: string | null;
  env: DocumentEnv;
  runServers?: AgentMcpServerInput[] | null;
}): Promise<AgentMcpServerInput[]> {
  const document = await loadDocumentMcpServerInputs(args.documentId, args.env);

  let workspace: AgentMcpServerInput[] = [];
  const workspaceDocumentId = await resolveWorkspaceDocumentId(args.documentId).catch(() => null);
  if (workspaceDocumentId && workspaceDocumentId !== args.documentId) {
    const servers = await listDocumentMcpServers(workspaceDocumentId);
    if (servers.length > 0) {
      const workspaceEnv = await loadDocumentEnv(workspaceDocumentId).catch(() => ({}) as DocumentEnv);
      workspace = resolveMcpServerInputs(servers, { ...workspaceEnv, ...args.env });
    }
  }

  const user = args.userId ? await loadUserMcpServerInputs(args.userId) : [];
  return mergeMcpServerInputs({ run: args.runServers ?? [], document, workspace, user });
}

/** Servers a document run inherits from other scopes, for display in the environment menu. */
export async function listInheritedMcpServers(documentId: string, userId: string | null): Promise<InheritedMcpServer[]> {
  const own = new Set((await listDocumentMcpServers(documentId)).map((server) => server.name));
  const out: InheritedMcpServer[] = [];
  const workspaceDocumentId = await resolveWorkspaceDocumentId(documentId).catch(() => null);
  if (workspaceDocumentId && workspaceDocumentId !== documentId) {
    for (const server of await listDocumentMcpServers(workspaceDocumentId)) {
      out.push({ name: server.name, url: server.url, scope: "workspace", shadowed: own.has(server.name) });
      own.add(server.name);
    }
  }
  if (userId) {
    for (const server of await listUserMcpServers(userId)) {
      out.push({ name: server.name, url: server.url, scope: "user", shadowed: own.has(server.name) });
    }
  }
  return out;
}
