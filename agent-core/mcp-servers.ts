/**
 * Document-configured MCP servers (DocumentMcpServer rows), resolved by the app
 * into `{name, url, headers}` and shipped with the job like `slackTools`. Pure
 * helpers shared by both harnesses so the option shapes cannot drift.
 */
export type AgentMcpServerInput = {
  name: string;
  url: string;
  /** Already-resolved request headers (e.g. Authorization). Never persisted. */
  headers?: Record<string, string>;
};

export const MCP_SERVER_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** Names of the servers r-docs mounts itself; a document server cannot shadow them. */
export const RESERVED_MCP_SERVER_NAMES = new Set(["gdocs", "rdocs"]);

export function isValidMcpServerName(name: string): boolean {
  return MCP_SERVER_NAME_RE.test(name) && !RESERVED_MCP_SERVER_NAMES.has(name);
}

export function isValidMcpServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Claude Agent SDK `mcpServers` entries. */
export function claudeMcpServerOptions(servers: AgentMcpServerInput[] | undefined) {
  const out: Record<string, { type: "http"; url: string; headers?: Record<string, string> }> = {};
  for (const server of servers ?? []) {
    if (!isValidMcpServerName(server.name)) continue;
    out[server.name] = {
      type: "http",
      url: server.url,
      ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: server.headers } : {})
    };
  }
  return out;
}

/** Codex `mcp_servers` entries. Not `required`: a down server degrades, never blocks the run. */
export function codexMcpServerOptions(servers: AgentMcpServerInput[] | undefined) {
  const out: Record<string, { url: string; http_headers?: Record<string, string>; required: boolean }> = {};
  for (const server of servers ?? []) {
    if (!isValidMcpServerName(server.name)) continue;
    out[server.name] = {
      url: server.url,
      ...(server.headers && Object.keys(server.headers).length > 0 ? { http_headers: server.headers } : {}),
      required: false
    };
  }
  return out;
}

/** Whole-server allow entries (`mcp__<name>`) for the SDK tool allowlist. */
export function mcpServerAllowedTools(servers: AgentMcpServerInput[] | undefined): string[] {
  return (servers ?? []).filter((server) => isValidMcpServerName(server.name)).map((server) => `mcp__${server.name}`);
}
