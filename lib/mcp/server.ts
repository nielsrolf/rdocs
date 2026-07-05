import { z } from "zod";

import { McpEditError } from "@/lib/mcp/apply-edit";
import { callMcpTool, MCP_TOOLS, McpToolError, type McpToolContext } from "@/lib/mcp/tools";
import { McpFileError } from "@/lib/mcp/workspace-files";

// Minimal stateless MCP server over streamable HTTP (single POST endpoint,
// plain-JSON responses). Only the tool surface is implemented — no resources,
// prompts, sessions or server-initiated streams — which is exactly what
// `claude mcp add --transport http` needs.

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "gdocs-ai", title: "gdocs-ai documents", version: "1.0.0" };

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolInputSchema(tool: (typeof MCP_TOOLS)[number]) {
  const jsonSchema = z.toJSONSchema(tool.schema, { io: "input" }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}

export function listMcpToolDefinitions() {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toolInputSchema(tool)
  }));
}

// Handle one JSON-RPC message. Returns null for notifications (no response).
export async function handleMcpMessage(
  message: JsonRpcRequest,
  ctx: McpToolContext
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined;
  const method = message.method;

  if (message.jsonrpc !== "2.0" || typeof method !== "string") {
    return isNotification ? null : rpcError(id, -32600, "Invalid JSON-RPC request.");
  }

  if (method.startsWith("notifications/")) {
    return null;
  }

  try {
    switch (method) {
      case "initialize": {
        const requested = message.params?.protocolVersion;
        const protocolVersion =
          typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            "Tools for reading and editing gdocs-ai documents. Start with read_document (accepts document URLs); make targeted edits with replace_in_document; upload widget/image files with upload_files or create_widget before referencing them in markdown."
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: listMcpToolDefinitions() });
      case "tools/call": {
        const name = message.params?.name;
        if (typeof name !== "string") {
          return rpcError(id, -32602, "tools/call requires a tool name.");
        }
        try {
          const result = await callMcpTool(name, message.params?.arguments, ctx);
          const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          return rpcResult(id, { content: [{ type: "text", text }], isError: false });
        } catch (error) {
          if (
            error instanceof McpToolError ||
            error instanceof McpEditError ||
            error instanceof McpFileError
          ) {
            // Tool-level failure: surfaced to the model as a tool result so it
            // can correct itself (bad find_text, missing access, …).
            return rpcResult(id, { content: [{ type: "text", text: error.message }], isError: true });
          }
          throw error;
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    console.error("[mcp] request failed", {
      method,
      error: error instanceof Error ? error.message : error
    });
    return isNotification ? null : rpcError(id, -32603, "Internal error.");
  }
}

// Handle a full POST body (single message or batch).
export async function handleMcpBody(
  body: unknown,
  ctx: McpToolContext
): Promise<{ status: number; payload: unknown | null }> {
  if (Array.isArray(body)) {
    const responses = (
      await Promise.all(body.map((message) => handleMcpMessage(message as JsonRpcRequest, ctx)))
    ).filter((response): response is JsonRpcResponse => response !== null);
    return responses.length > 0 ? { status: 200, payload: responses } : { status: 202, payload: null };
  }
  if (!body || typeof body !== "object") {
    return { status: 400, payload: rpcError(null, -32700, "Parse error.") };
  }
  const response = await handleMcpMessage(body as JsonRpcRequest, ctx);
  return response ? { status: 200, payload: response } : { status: 202, payload: null };
}
