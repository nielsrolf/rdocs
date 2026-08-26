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
    name: "message_thread",
    description:
      "Send a message into ANOTHER Slack thread, where it is treated exactly like a message from a person: it steers the " +
      "agent already working in that thread, or starts a new agent run there. Use it to supervise, unblock or redirect " +
      "another agent. Omit thread_ts to start a new top-level thread in that channel. Not for your own conversation.",
    inputSchema: objectSchema({ channel_id: string, thread_ts: string, text: string }, ["channel_id", "text"])
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
    name: "check_back_later",
    description:
      "Park the current turn and be woken up in this thread later. Use for long background work (training runs, builds, " +
      "long-running scripts): start the work detached, call this with the delay and a self-contained note to your future " +
      "self, then END your turn — never sleep or poll while waiting.",
    inputSchema: objectSchema(
      {
        after_minutes: { type: "integer", minimum: 1, maximum: 1440 },
        instruction: string
      },
      ["after_minutes", "instruction"]
    )
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
  },
  {
    name: "set_channel_workspace",
    description:
      "Make an rdocs document the backing document of this Slack channel. The separate channel document is merged " +
      "away, so the target document's content, environment, agent settings, workspace, and agent history apply to " +
      'the channel. Pass a document id or URL, or "none" to disconnect. Requires edit access to the target document.',
    inputSchema: objectSchema({ document: string }, ["document"])
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
