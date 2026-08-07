import assert from "node:assert/strict";
import test from "node:test";

import {
  handleSlackAgentMcpMessage,
  listSlackAgentMcpToolDefinitions
} from "../lib/slack/agent-tools-mcp";

test("Slack MCP exposes the cross-thread tools available in the Claude harness", () => {
  const names = new Set(listSlackAgentMcpToolDefinitions().map((tool) => tool.name));
  for (const name of [
    "post_slack_message",
    "list_slack_channels",
    "read_slack_channel",
    "read_slack_thread",
    "send_slack_file",
    "schedule_task",
    "list_scheduled_tasks",
    "cancel_scheduled_task"
  ]) {
    assert.ok(names.has(name), `${name} should be exposed over MCP`);
  }
});

test("Slack MCP forwards tool calls and preserves tool-level errors", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const response = await handleSlackAgentMcpMessage(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "read_slack_thread",
        arguments: { channel_id: "C1", thread_ts: "123.4" }
      }
    },
    async (request) => {
      calls.push(request);
      return { ok: true, text: "thread transcript" };
    }
  );
  assert.deepEqual(calls, [
    { tool: "read_slack_thread", args: { channel_id: "C1", thread_ts: "123.4" } }
  ]);
  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 7,
    result: { content: [{ type: "text", text: "thread transcript" }], isError: false }
  });
});
