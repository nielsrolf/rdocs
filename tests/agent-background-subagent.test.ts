import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runClaudeResearchAgent, type ClaudeAgentProgressEvent } from "../agent-core/agent";
import { createAgentInputChannel } from "../agent-core/input-channel";

// 2026-09-24 incident (#rl-playground, run cmufpgsjx0652nweribgdo70s). The agent
// launched background subagents (the Agent tool is async by default) and ended
// its turn to wait for them. The result frame closed the steering channel,
// which ends the SDK's input stream, and the SDK then closes the CLI's stdin.
// When the subagents finished, the CLI resumed the agent on its own, but every
// in-process gdocs tool (post_slack_message, set_channel_workspace,
// submit_response) gets its result back over that stdin, so each call came back
// at once as "The tool call was interrupted before a result was received". HTTP
// MCP tools kept working because they don't use stdin.
//
// This drives the REAL bundled CLI against a fake Anthropic endpoint:
//   main turn 1: launch a background subagent, then end the turn
//   subagent:    answer only after the main turn has ended
//   main turn 2: (woken by the task notification) call submit_response

const SUBAGENT_MARKER = "SUBAGENT_TASK_7f3a";
const REPLY = "subagent result delivered";

type Block = { type: string; text?: string; content?: unknown; tool_use_id?: string; name?: string };
type Msg = { role: string; content: string | Block[] };

function textOf(content: Msg["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (typeof b.text === "string" ? b.text : typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "")))
    .join("\n");
}

function sse(res: http.ServerResponse, blocks: Array<{ type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown }>) {
  const stopReason = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  send("message_start", {
    type: "message_start",
    message: {
      id: `msg_${Math.random().toString(36).slice(2)}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 }
    }
  });
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      send("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2)}`, name: block.name, input: {} }
      });
      send("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
      });
    }
    send("content_block_stop", { type: "content_block_stop", index });
  });
  send("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

test("gdocs tools still work after the agent waits for a background subagent", { timeout: 120_000 }, async (t) => {
  try {
    await import("@anthropic-ai/claude-agent-sdk");
  } catch {
    t.skip("claude-agent-sdk not installed");
    return;
  }

  let mainTurnEnded!: () => void;
  const mainTurnEndedPromise = new Promise<void>((resolve) => (mainTurnEnded = resolve));
  const submitResults: string[] = [];

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      const body = JSON.parse(raw) as { messages: Msg[]; tools?: Array<{ name: string }> };
      const messages = body.messages ?? [];
      const toolNames = new Set((body.tools ?? []).map((tool) => tool.name));
      const userText = messages
        .filter((m) => m.role === "user")
        .map((m) => textOf(m.content))
        .join("\n");
      const hasAssistant = messages.some((m) => m.role === "assistant");
      const last = messages.at(-1);
      const lastText = last ? textOf(last.content) : "";

      // Auxiliary CLI requests (titles, summaries) carry no tools.
      if (!toolNames.size) return sse(res, [{ type: "text", text: "ok" }]);

      // The subagent's own conversation starts with the prompt the main agent
      // gave it; the main conversation only ever echoes it in tool results.
      if (!hasAssistant && userText.includes(SUBAGENT_MARKER)) {
        // Finish only after the main agent has ended its turn to wait.
        await mainTurnEndedPromise;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return sse(res, [{ type: "text", text: "subagent finished" }]);
      }

      const lastBlocks = Array.isArray(last?.content) ? (last!.content as Block[]) : [];
      const submitResult = lastBlocks.find((b) => b.type === "tool_result");
      if (!hasAssistant) {
        return sse(res, [
          { type: "tool_use", name: "Agent", input: { description: "background research", prompt: `${SUBAGENT_MARKER}: say done`, subagent_type: "general-purpose" } }
        ]);
      }
      if (lastText.includes("<task-notification>")) {
        return sse(res, [{ type: "tool_use", name: "mcp__gdocs__submit_response", input: { reply: REPLY } }]);
      }
      const assistantBefore = messages.at(-2);
      const calledSubmit =
        Array.isArray(assistantBefore?.content) &&
        (assistantBefore!.content as Block[]).some((b) => b.type === "tool_use" && b.name === "mcp__gdocs__submit_response");
      if (calledSubmit && submitResult) {
        submitResults.push(lastText);
        return sse(res, [{ type: "text", text: "done" }]);
      }
      // After the Agent launch result: end the turn and wait for the notification.
      mainTurnEnded();
      return sse(res, [{ type: "text", text: "Waiting for the background agent." }]);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bg-subagent-"));
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace);
  const events: ClaudeAgentProgressEvent[] = [];
  const inputChannel = createAgentInputChannel();

  try {
    const output = await runClaudeResearchAgent(
      {
        mode: "conversation",
        documentTitle: "Test",
        documentText: "",
        unresolvedThreads: [],
        workspacePath: workspace,
        workspaceOverview: "",
        instruction: "Research something in the background."
      },
      {
        onProgress: (event) => {
          events.push(event);
        },
        agentConfig: { model: "claude-sonnet-5" },
        agentEnv: { ANTHROPIC_API_KEY: "sk-ant-api03-test", ANTHROPIC_BASE_URL: baseUrl },
        sessionConfigDir: path.join(tmp, "session"),
        inputChannel,
        isolatedRuntime: true
      }
    );

    assert.equal(submitResults.length, 1, "the agent never got a submit_response result back");
    assert.doesNotMatch(submitResults[0], /interrupted before a result/);
    assert.match(submitResults[0], /Final response captured/);
    assert.equal(output.reply, REPLY);
    assert.ok(
      events.some((event) => event.role === "system" && /Waiting for 1 background agent/.test(event.message)),
      "the timeline should say the session is waiting for the subagent"
    );
  } finally {
    inputChannel.close();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
