#!/usr/bin/env node
// A fake `codex app-server` that speaks the real JSON-RPC-over-stdio protocol.
//
// It exists so the app-server harness can be tested end to end without an API
// key, a model, or the real (experimental, several-hundred-MB) codex binary.
// Point CODEX_APP_SERVER_BIN at this file.
//
// Scripting knobs (all env vars):
//   FAKE_CODEX_LOG          append every received JSON-RPC message as NDJSON
//   FAKE_CODEX_AWAIT_STEER  "1" → the turn stays in progress until a turn/steer
//                           arrives, and the steered text is echoed back in the
//                           final agent message (this is the steering assertion)
//   FAKE_CODEX_REPLY        text of the final agent message (default: a valid
//                           r-docs structured submission)
//   FAKE_CODEX_FAIL_TURN    "1" → emit turn/completed with status "failed"
//   FAKE_CODEX_FAIL_RESUME  "1" → thread/resume replies with a JSON-RPC error
//                           mimicking a missing rollout file (thread/start
//                           still succeeds)
//   FAKE_CODEX_THREAD_ID    thread id to report (default "thread-fake-1")

import fs from "node:fs";
import readline from "node:readline";

const logPath = process.env.FAKE_CODEX_LOG;
const awaitSteer = process.env.FAKE_CODEX_AWAIT_STEER === "1";
const failTurn = process.env.FAKE_CODEX_FAIL_TURN === "1";
const threadId = process.env.FAKE_CODEX_THREAD_ID || "thread-fake-1";
const defaultReply = JSON.stringify({
  summary: "fake run",
  replacementText: "hello from the fake codex app-server",
  reply: "",
  images: [],
  widgets: [],
  comments: [],
  suggestions: [],
  sources: []
});

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
function record(msg) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${JSON.stringify(msg)}\n`);
  } catch {
    // ignore
  }
}

let turnCounter = 0;
let activeTurnId = null;
let steeredText = null;

function completeTurn(turnId) {
  if (activeTurnId !== turnId) return;
  activeTurnId = null;
  if (failTurn) {
    notify("turn/completed", {
      threadId,
      turn: { id: turnId, items: [], status: "failed", error: { message: "fake turn failure" } }
    });
    return;
  }
  let text = process.env.FAKE_CODEX_REPLY || defaultReply;
  if (steeredText) {
    // Fold the steered text into the structured reply so the assertion can see
    // that the message really reached the RUNNING turn, while the payload stays
    // a valid r-docs submission.
    try {
      const parsed = JSON.parse(text);
      parsed.reply = `${parsed.reply || ""}STEERED:${steeredText}`;
      text = JSON.stringify(parsed);
    } catch {
      text = `${text}\nSTEERED:${steeredText}`;
    }
  }
  notify("item/completed", {
    threadId,
    turnId,
    completedAtMs: 1,
    item: { type: "agentMessage", id: "msg-1", text }
  });
  notify("turn/completed", {
    threadId,
    turn: { id: turnId, items: [], status: "completed" }
  });
}

function startTurn(id, params) {
  const turnId = `turn-${++turnCounter}`;
  activeTurnId = turnId;
  steeredText = null;
  send({ jsonrpc: "2.0", id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
  notify("turn/started", { threadId, turn: { id: turnId, items: [], status: "inProgress" } });
  notify("turn/plan/updated", {
    threadId,
    turnId,
    plan: [
      { step: "look around", status: "completed" },
      { step: "do the thing", status: "inProgress" }
    ]
  });
  notify("item/started", {
    threadId,
    turnId,
    startedAtMs: 1,
    item: { type: "commandExecution", id: "cmd-1", command: "echo hi", status: "inProgress", cwd: "/workspace" }
  });
  notify("item/completed", {
    threadId,
    turnId,
    completedAtMs: 2,
    item: {
      type: "commandExecution",
      id: "cmd-1",
      command: "echo hi",
      aggregatedOutput: "hi\n",
      exitCode: 0,
      status: "completed",
      cwd: "/workspace"
    }
  });
  notify("item/completed", {
    threadId,
    turnId,
    completedAtMs: 3,
    item: { type: "reasoning", id: "r-1", content: ["thinking about it"], summary: [] }
  });
  if (!awaitSteer) {
    setTimeout(() => completeTurn(turnId), 5);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  record(msg);
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { userAgent: "fake-codex/0.0.0" } });
    return;
  }
  if (method === "initialized") return;
  if (method === "thread/start") {
    send({ jsonrpc: "2.0", id, result: { thread: { id: threadId } } });
    notify("thread/started", { thread: { id: threadId } });
    return;
  }
  if (method === "thread/resume") {
    if (process.env.FAKE_CODEX_FAIL_RESUME === "1") {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: `failed to resolve rollout path for thread ${params?.threadId}: file does not exist`
        }
      });
      return;
    }
    send({ jsonrpc: "2.0", id, result: { thread: { id: params?.threadId || threadId } } });
    return;
  }
  if (method === "turn/start") {
    startTurn(id, params);
    return;
  }
  if (method === "turn/steer") {
    if (!activeTurnId || params?.expectedTurnId !== activeTurnId) {
      send({ jsonrpc: "2.0", id, error: { code: -32004, message: "no matching active turn" } });
      return;
    }
    steeredText = (params.input || []).map((part) => part.text).join(" ");
    send({ jsonrpc: "2.0", id, result: { turnId: activeTurnId } });
    notify("item/completed", {
      threadId,
      turnId: activeTurnId,
      completedAtMs: 4,
      item: { type: "userMessage", id: "u-2", content: [{ type: "text", text: steeredText }] }
    });
    setTimeout(() => completeTurn(activeTurnId), 5);
    return;
  }
  if (method === "turn/interrupt") {
    const turnId = activeTurnId;
    activeTurnId = null;
    send({ jsonrpc: "2.0", id, result: {} });
    if (turnId) {
      notify("turn/completed", { threadId, turn: { id: turnId, items: [], status: "interrupted" } });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
rl.on("close", () => process.exit(0));
