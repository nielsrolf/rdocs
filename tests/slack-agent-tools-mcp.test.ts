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
    "check_back_later",
    "list_scheduled_tasks",
    "cancel_scheduled_task",
    "message_thread",
    "set_channel_workspace",
    "set_channel_repository"
  ]) {
    assert.ok(names.has(name), `${name} should be exposed over MCP`);
  }
});

test("Slack MCP describes set_channel_repository with repository and optional branch", () => {
  const definition = listSlackAgentMcpToolDefinitions().find(
    (tool) => tool.name === "set_channel_repository"
  );
  assert.ok(definition, "set_channel_repository must be in the Codex MCP schema list");
  const schema = definition!.inputSchema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.deepEqual(Object.keys(schema.properties).sort(), ["branch", "repository"]);
  assert.deepEqual(schema.required, ["repository"]);
});

test("Slack MCP describes message_thread with channel_id/thread_ts/text", () => {
  const definition = listSlackAgentMcpToolDefinitions().find((tool) => tool.name === "message_thread");
  assert.ok(definition, "message_thread must be in the Codex MCP schema list");
  const schema = definition!.inputSchema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.deepEqual(Object.keys(schema.properties).sort(), ["channel_id", "text", "thread_ts"]);
  assert.deepEqual(schema.required.sort(), ["channel_id", "text"]);
});

test("Slack MCP forwards message_thread calls with its arguments", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const response = await handleSlackAgentMcpMessage(
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "message_thread",
        arguments: { channel_id: "C2", thread_ts: "5.5", text: "unblock yourself" }
      }
    },
    async (request) => {
      calls.push(request);
      return { ok: true, text: "Steered the live run." };
    }
  );
  assert.deepEqual(calls, [
    { tool: "message_thread", args: { channel_id: "C2", thread_ts: "5.5", text: "unblock yourself" } }
  ]);
  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 9,
    result: { content: [{ type: "text", text: "Steered the live run." }], isError: false }
  });
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
