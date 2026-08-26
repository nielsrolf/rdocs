import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CodexAppServerClient,
  resolveCodexBinary
} from "../agent-core/codex-app-server";
import {
  codexAppServerThreadConfig,
  codexV2ItemProgress,
  codexV2PlanProgress,
  runCodexResearchAgent
} from "../agent-core/codex-agent";
import { createAgentInputChannel } from "../agent-core/input-channel";

const FAKE_SERVER = path.join(__dirname, "fixtures", "fake-codex-app-server.mjs");

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function baseInput(workspacePath: string) {
  return {
    mode: "conversation" as const,
    instruction: "say hi",
    documentTitle: "Test document",
    documentText: "",
    unresolvedThreads: [],
    workspacePath,
    workspaceOverview: "",
    accessMode: "full" as const
  };
}

function readLog(logPath: string): Record<string, unknown>[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("an explicit binary override wins over platform-package resolution", () => {
  assert.equal(resolveCodexBinary({ CODEX_APP_SERVER_BIN: "/tmp/fake-codex" }), "/tmp/fake-codex");
});

test("the codex binary resolves from the installed platform package", () => {
  // Guards the container case: resolution must be anchored on the module
  // directory, not process.cwd() (the agent container runs with cwd
  // /workspace while node_modules lives at /agent/node_modules).
  const previous = process.cwd();
  const scratch = tempDir("codex-cwd-");
  try {
    process.chdir(scratch);
    const resolved = resolveCodexBinary({});
    assert.ok(fs.statSync(resolved).isFile(), `expected a real codex binary at ${resolved}`);
  } finally {
    process.chdir(previous);
  }
});

test("the codex binary resolves in the container's ESM layout (no __dirname, cwd outside the install)", () => {
  // Reproduces the 2026-08-16..18 scheduled-run failures: the agent images run
  // agent-core via tsx under `"type": "module"`, so `__dirname` does not exist
  // and cwd is /workspace — neither anchor reached /agent/node_modules. The
  // resolver must also anchor on the entrypoint script (process.argv[1]).
  const install = tempDir("codex-esm-install-"); // stands in for /agent
  const scratchCwd = tempDir("codex-esm-cwd-"); // stands in for /workspace
  fs.writeFileSync(path.join(install, "package.json"), JSON.stringify({ type: "module" }));
  fs.mkdirSync(path.join(install, "agent-core"));
  fs.copyFileSync(
    path.join(__dirname, "..", "agent-core", "codex-app-server.ts"),
    path.join(install, "agent-core", "codex-app-server.ts")
  );
  // Fake platform package for THIS host's triple, beside the "entrypoint".
  const triples: Record<string, string> = {
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin"
  };
  const triple = triples[`${process.platform}-${process.arch}`];
  assert.ok(triple, `unsupported test host ${process.platform}/${process.arch}`);
  const pkgName = `codex-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch}`;
  const binDir = path.join(install, "node_modules", "@openai", pkgName, "vendor", triple, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "codex"), "#!/bin/sh\n");
  const entry = path.join(install, "entry.mts");
  fs.writeFileSync(
    entry,
    'import { resolveCodexBinary } from "./agent-core/codex-app-server.ts";\n' +
      "try { console.log('RESOLVED:' + resolveCodexBinary({})); } catch (e) { console.log('FAILED:' + e.message); }\n"
  );
  const tsxBin = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
  const result = spawnSync(tsxBin, [entry], { cwd: scratchCwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /RESOLVED:.*vendor.*bin.*codex/,
    `expected ESM resolution to succeed, got: ${result.stdout} ${result.stderr}`
  );
});

test("the JSON-RPC client completes the handshake and answers unknown server requests", async () => {
  const logPath = path.join(tempDir("codex-log-"), "rpc.ndjson");
  const client = await CodexAppServerClient.start({
    command: process.execPath,
    args: [FAKE_SERVER],
    env: { ...process.env, FAKE_CODEX_LOG: logPath } as Record<string, string>
  });
  try {
    const started = await client.request<{ thread: { id: string } }>("thread/start", { cwd: "/tmp" });
    assert.equal(started.thread.id, "thread-fake-1");
  } finally {
    client.close();
  }
  const log = readLog(logPath);
  assert.equal(log[0]?.method, "initialize");
  assert.equal(log[1]?.method, "initialized");
  assert.equal(log[2]?.method, "thread/start");
});

test("a message pushed onto the input channel is steered into the RUNNING turn", async () => {
  // This is the whole point of the app-server harness: on the exec/SDK path the
  // child's stdin is already closed by the time the turn is running, so a Slack
  // follow-up could only ever become a queued second run (the ⏳ reaction).
  // The fixture holds the turn open until a steer arrives and folds its text
  // into the structured reply, so this assertion fails (by timeout) if the
  // message is not delivered mid-turn.
  const workspacePath = tempDir("codex-ws-");
  const logPath = path.join(tempDir("codex-log-"), "rpc.ndjson");
  const inputChannel = createAgentInputChannel();
  const events: { role: string; message: string }[] = [];

  const run = runCodexResearchAgent(baseInput(workspacePath) as never, {
    agentConfig: { model: "codex/openai/gpt-5.6" },
    inputChannel,
    onProgress: (event) => {
      events.push(event as { role: string; message: string });
    },
    agentEnv: {
      CODEX_APP_SERVER_BIN: FAKE_SERVER,
      FAKE_CODEX_LOG: logPath,
      FAKE_CODEX_AWAIT_STEER: "1",
      OPENAI_API_KEY: "test-key"
    }
  });

  // Wait until the turn is genuinely in flight, then steer it.
  for (let i = 0; i < 400 && !readLog(logPath).some((m) => m.method === "turn/start"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(inputChannel.push("actually, also mention bananas"), true);

  const output = await run;
  assert.match(String(output.reply), /STEERED:actually, also mention bananas/);

  const log = readLog(logPath);
  const steer = log.find((message) => message.method === "turn/steer");
  assert.ok(steer, "expected a turn/steer request");
  const steerParams = steer.params as { expectedTurnId?: string; input?: { text?: string }[] };
  const turnStart = log.find((message) => message.method === "turn/start");
  assert.ok(steerParams.expectedTurnId, "steer must carry the active turn id precondition");
  assert.equal(steerParams.input?.[0]?.text, "actually, also mention bananas");
  // The submission schema still constrains the turn on the app-server path.
  assert.ok((turnStart?.params as { outputSchema?: unknown })?.outputSchema);

  // Tool activity from the v2 item stream reaches the run timeline.
  assert.ok(events.some((event) => event.message.startsWith("Bash: ")));
  assert.ok(events.some((event) => event.message.startsWith("TodoWrite: ")));
});

test("check_back_later parks a Codex run and the wake-up starts another turn in the same session", async () => {
  // Regression for the 2026-08-26 experiment run: Codex called
  // check_back_later successfully, then its mandatory structured response was
  // treated as final three seconds later. The container and /tmp state were
  // destroyed, and the alarm had to start a fresh run.
  const workspacePath = tempDir("codex-park-ws-");
  const logPath = path.join(tempDir("codex-park-log-"), "rpc.ndjson");
  const inputChannel = createAgentInputChannel();
  const events: { role: string; message: string }[] = [];
  let settled = false;
  const run = runCodexResearchAgent(baseInput(workspacePath) as never, {
    agentConfig: { model: "codex/openai/gpt-5.6" },
    inputChannel,
    onProgress: (event) => {
      events.push(event as { role: string; message: string });
    },
    agentEnv: {
      CODEX_APP_SERVER_BIN: FAKE_SERVER,
      FAKE_CODEX_LOG: logPath,
      FAKE_CODEX_PARK_SEQUENCE: "check_back_later",
      OPENAI_API_KEY: "test-key"
    }
  }).finally(() => {
    settled = true;
  });

  for (let i = 0; i < 200 && !events.some((event) => /Waiting for the check-back wake-up/.test(event.message)); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(events.some((event) => /Waiting for the check-back wake-up/.test(event.message)));
  assert.equal(settled, false, "the first structured response must not finalize an armed run");
  assert.equal(inputChannel.push("[Scheduled task firing] wake up now"), true);

  const output = await run;
  assert.match(String(output.replacementText), /hello from the fake codex/);
  const starts = readLog(logPath).filter((message) => message.method === "turn/start");
  assert.equal(starts.length, 2, "the wake-up must start a second turn on the same app-server thread");
  assert.equal(
    (starts[1]?.params as { threadId?: string })?.threadId,
    (starts[0]?.params as { threadId?: string })?.threadId
  );
});

test("keep_alive_after_turn survives messages until Codex explicitly disables it", async () => {
  const workspacePath = tempDir("codex-keep-alive-ws-");
  const logPath = path.join(tempDir("codex-keep-alive-log-"), "rpc.ndjson");
  const inputChannel = createAgentInputChannel();
  const events: { role: string; message: string }[] = [];
  let settled = false;
  const run = runCodexResearchAgent(baseInput(workspacePath) as never, {
    agentConfig: { model: "codex/openai/gpt-5.6" },
    inputChannel,
    onProgress: (event) => {
      events.push(event as { role: string; message: string });
    },
    agentEnv: {
      CODEX_APP_SERVER_BIN: FAKE_SERVER,
      FAKE_CODEX_LOG: logPath,
      FAKE_CODEX_PARK_SEQUENCE: "keep_alive_on,keep_alive_off",
      OPENAI_API_KEY: "test-key"
    }
  }).finally(() => {
    settled = true;
  });

  for (let i = 0; i < 200 && !events.some((event) => /Codex keep-alive is on/.test(event.message)); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(events.some((event) => /Codex keep-alive is on/.test(event.message)));
  assert.equal(settled, false, "keep-alive must hold the run open after the first turn");
  assert.equal(inputChannel.push("how is the background job going?"), true);

  await run;
  const starts = readLog(logPath).filter((message) => message.method === "turn/start");
  assert.equal(starts.length, 2);
});

test("a failed turn surfaces the server's error instead of an empty submission", async () => {
  const workspacePath = tempDir("codex-ws-");
  await assert.rejects(
    runCodexResearchAgent(baseInput(workspacePath) as never, {
      agentConfig: { model: "codex/openai/gpt-5.6" },
      agentEnv: {
        CODEX_APP_SERVER_BIN: FAKE_SERVER,
        FAKE_CODEX_FAIL_TURN: "1",
        OPENAI_API_KEY: "test-key"
      }
    }),
    /fake turn failure/
  );
});

test("the session id reported by the app-server is recorded for resume", async () => {
  const workspacePath = tempDir("codex-ws-");
  const sessions: string[] = [];
  await runCodexResearchAgent(baseInput(workspacePath) as never, {
    agentConfig: { model: "codex/openai/gpt-5.6" },
    onSessionId: (id) => {
      sessions.push(id);
    },
    agentEnv: {
      CODEX_APP_SERVER_BIN: FAKE_SERVER,
      FAKE_CODEX_THREAD_ID: "thread-resume-me",
      OPENAI_API_KEY: "test-key"
    }
  });
  assert.ok(sessions.includes("thread-resume-me"));
});

test("a failed thread/resume degrades to a fresh thread with a visible event, not a failed run", async () => {
  // 2026-08-23 incident: a recorded sdkSessionId pointed at a rollout file that
  // does not exist in this environment; `thread/resume` errored ("failed to
  // resolve rollout path ...: file does not exist") and the whole run FAILED.
  // The host-side existence check (planSessionResume) cannot catch every case,
  // so the harness itself must fall back to thread/start — loudly.
  const workspacePath = tempDir("codex-ws-");
  const logPath = path.join(tempDir("codex-log-"), "rpc.ndjson");
  const events: { role: string; message: string }[] = [];
  const sessions: string[] = [];

  const output = await runCodexResearchAgent(
    { ...baseInput(workspacePath), resumeSessionId: "thread-that-is-gone" } as never,
    {
      agentConfig: { model: "codex/openai/gpt-5.6" },
      onProgress: (event) => {
        events.push(event as { role: string; message: string });
      },
      onSessionId: (id) => {
        sessions.push(id);
      },
      agentEnv: {
        CODEX_APP_SERVER_BIN: FAKE_SERVER,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_FAIL_RESUME: "1",
        OPENAI_API_KEY: "test-key"
      }
    }
  );

  // The run completes normally on the fresh thread.
  assert.match(String(output.replacementText), /hello from the fake codex/);
  assert.ok(sessions.includes("thread-fake-1"), "fresh thread id must be recorded for future resume");

  // The degradation is visible in the run timeline, never silent.
  assert.ok(
    events.some(
      (event) =>
        event.role === "system" && /previous session .*not|no longer/i.test(event.message)
    ),
    `expected a visible resume-degradation system event, got: ${JSON.stringify(events)}`
  );

  // Protocol-level proof: resume was attempted, then a fresh thread started.
  const methods = readLog(logPath).map((message) => message.method);
  assert.ok(methods.includes("thread/resume"), "resume must be attempted first");
  assert.ok(methods.includes("thread/start"), "must fall back to thread/start");
});

test("v2 thread items map onto the existing timeline rows", () => {
  assert.deepEqual(
    codexV2ItemProgress({
      type: "commandExecution",
      id: "c1",
      command: "ls -la",
      status: "inProgress"
    }),
    { role: "tool", message: 'Bash: {"command":"ls -la"}' }
  );
  assert.deepEqual(
    codexV2ItemProgress({
      type: "commandExecution",
      id: "c1",
      command: "ls -la",
      aggregatedOutput: "a\nb\n",
      exitCode: 0,
      status: "completed"
    }),
    { role: "tool_result", message: JSON.stringify({ stdout: "a\nb\n", stderr: "", exitCode: 0 }) }
  );
  assert.deepEqual(
    codexV2ItemProgress({ type: "reasoning", id: "r1", content: ["because"], summary: [] }),
    { role: "agent", message: "because" }
  );
  assert.deepEqual(
    codexV2ItemProgress({
      type: "mcpToolCall",
      id: "m1",
      server: "gdocs",
      tool: "post_slack_message",
      arguments: { text: "hi" },
      status: "inProgress"
    }),
    { role: "tool", message: 'mcp__gdocs__post_slack_message: {"text":"hi"}' }
  );
  assert.equal(codexV2ItemProgress({ type: "agentMessage", id: "a1", text: "hello" }), null);
  assert.equal(codexV2ItemProgress({ type: "userMessage", id: "u1" }), null);
});

test("a plan update renders as the TodoWrite snapshot the plan rail already reads", () => {
  const event = codexV2PlanProgress({
    plan: [
      { step: "read the code", status: "completed" },
      { step: "write the patch", status: "inProgress" },
      { step: "run tests", status: "pending" }
    ]
  });
  assert.equal(event?.role, "tool");
  const payload = JSON.parse(String(event?.message).replace(/^TodoWrite: /, "")) as {
    todos: { content: string; status: string }[];
  };
  assert.deepEqual(payload.todos, [
    { content: "read the code", status: "completed" },
    { content: "write the patch", status: "in_progress" },
    { content: "run tests", status: "pending" }
  ]);
  assert.equal(codexV2PlanProgress({ plan: [] }), null);
});

test("a custom OpenAI base URL becomes a named app-server model provider", () => {
  const { config, modelProvider } = codexAppServerThreadConfig(
    { config: { show_raw_agent_reasoning: false }, baseUrl: "https://proxy.example.com", apiKey: "k" },
    "high"
  );
  assert.equal(modelProvider, "rdocs_openai");
  assert.equal(config.model_reasoning_effort, "high");
  assert.deepEqual((config.model_providers as Record<string, unknown>).rdocs_openai, {
    name: "r-docs OpenAI",
    base_url: "https://proxy.example.com/v1",
    env_key: "OPENAI_API_KEY",
    wire_api: "responses"
  });
});
