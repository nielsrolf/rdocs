import type { SlackAgentToolRequest, SlackAgentToolResult } from "@/lib/slack/agent-tools";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});
const string = { type: "string" };
const limit = { type: "integer", minimum: 1, maximum: 100 };

const SLACK_MCP_TOOLS: ToolDefinition[] = [
  {
    name: "post_slack_message",
    description: "Post one short interim status update to the current Slack conversation. Do not use for the final answer.",
    inputSchema: objectSchema({ text: string }, ["text"])
  },
  {
    name: "list_slack_channels",
    description: "List channels that both the triggering user and the bot are members of.",
    inputSchema: objectSchema({})
  },
  {
    name: "read_slack_channel",
    description: "Read recent top-level messages from an allowed Slack channel; timestamps can be passed to read_slack_thread.",
    inputSchema: objectSchema({ channel_id: string, limit }, ["channel_id"])
  },
  {
    name: "read_slack_thread",
    description: "Read replies from one thread in an allowed Slack channel.",
    inputSchema: objectSchema({ channel_id: string, thread_ts: string, limit }, ["channel_id", "thread_ts"])
  },
  {
    name: "recent_activity",
    description: "Show recent agent activity across rdocs projects visible to the triggering user.",
    inputSchema: objectSchema({ project: string, limit })
  },
  {
    name: "schedule_task",
    description: "Schedule a recurring or one-shot task in the current Slack conversation.",
    inputSchema: objectSchema({
      instruction: string,
      cron: string,
      at: string,
      timezone: string,
      context: { type: "string", enum: ["thread", "channel"] }
    }, ["instruction"])
  },
  {
    name: "list_scheduled_tasks",
    description: "List active scheduled tasks for the current Slack conversation.",
    inputSchema: objectSchema({})
  },
  {
    name: "cancel_scheduled_task",
    description: "Cancel an active scheduled task by id.",
    inputSchema: objectSchema({ task_id: string }, ["task_id"])
  },
  {
    name: "send_slack_file",
    description: "Send a base64-encoded file to the current Slack conversation.",
    inputSchema: objectSchema(
      { filename: string, title: string, content_base64: string },
      ["filename", "content_base64"]
    )
  }
];

export function listSlackAgentMcpToolDefinitions(): ToolDefinition[] {
  return SLACK_MCP_TOOLS;
}

const TOOL_NAMES = new Set(SLACK_MCP_TOOLS.map((tool) => tool.name));

export async function handleSlackAgentMcpMessage(
  message: JsonRpcRequest,
  execute: (request: SlackAgentToolRequest) => Promise<SlackAgentToolResult>
): Promise<Record<string, unknown> | null> {
  const id = message.id ?? null;
  const notification = message.id === undefined;
  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
  const error = (code: number, text: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: text }
  });
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return notification ? null : error(-32600, "Invalid JSON-RPC request.");
  }
  if (message.method.startsWith("notifications/")) return null;
  if (message.method === "initialize") {
    return result({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "r-docs-slack", title: "r-docs Slack tools", version: "1.0.0" },
      instructions: "Read permitted Slack channels and threads, post sparse progress updates, share files, and manage scheduled tasks."
    });
  }
  if (message.method === "ping") return result({});
  if (message.method === "tools/list") return result({ tools: listSlackAgentMcpToolDefinitions() });
  if (message.method !== "tools/call") return error(-32601, `Method not found: ${message.method}`);

  const name = message.params?.name;
  if (typeof name !== "string" || !TOOL_NAMES.has(name)) {
    return error(-32602, "Unknown Slack tool.");
  }
  const rawArgs = message.params?.arguments;
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
    ? (rawArgs as Record<string, unknown>)
    : {};
  const tool = name === "send_slack_file" ? "send_file" : name;
  const executed = await execute({ tool: tool as SlackAgentToolRequest["tool"], args });
  return result({
    content: [{ type: "text", text: executed.text }],
    isError: !executed.ok
  });
}
