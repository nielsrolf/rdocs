import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODEX_SUBMISSION_JSON_SCHEMA,
  MAX_SUBMISSION_ATTEMPTS,
  codexItemProgress,
  codexProviderConfig,
  loadCodexSdk,
  runCodexSubmissionLoop
} from "../agent-core/codex-agent";

test("Codex Slack runs attach the same Slack and rdocs MCP surfaces Claude receives", () => {
  const configured = codexProviderConfig(
    "openai",
    { OPENAI_API_KEY: "test" },
    {
      slackTools: {
        url: "https://docs.example/api/slack/agent-tools",
        mcpUrl: "https://docs.example/api/mcp",
        token: "run-token"
      }
    }
  );
  const servers = configured.config.mcp_servers as Record<string, { url?: string }>;
  assert.equal(servers.gdocs?.url, "https://docs.example/api/slack/agent-tools");
  assert.equal(servers.rdocs?.url, "https://docs.example/api/mcp");
});

test("the import-only Codex SDK loads from the app's CommonJS test runtime", async () => {
  const sdk = await loadCodexSdk();
  assert.equal(typeof sdk.Codex, "function");
});

test("Codex structured output schema requires every top-level field", () => {
  const required = new Set((CODEX_SUBMISSION_JSON_SCHEMA as { required?: string[] }).required ?? []);
  assert.deepEqual(
    required,
    new Set(["replacementText", "reply", "sources", "images", "widgets", "summary", "suggestions", "comments"])
  );
  assert.equal((CODEX_SUBMISSION_JSON_SCHEMA as { additionalProperties?: boolean }).additionalProperties, false);
});

test("Codex native stream items map into the existing agent timeline roles", () => {
  assert.deepEqual(
    codexItemProgress({
      id: "cmd-1",
      type: "command_execution",
      command: "git status --short",
      aggregated_output: " M file.ts",
      exit_code: 0,
      status: "completed"
    }),
    {
      role: "tool_result",
      message: JSON.stringify({ stdout: " M file.ts", stderr: "", exitCode: 0 })
    }
  );
  assert.deepEqual(
    codexItemProgress({ id: "reason-1", type: "reasoning", text: "Inspecting the repository" }),
    { role: "agent", message: "Inspecting the repository" }
  );
});

test("Codex returns parse and validation failures to the same thread until the submission is valid", async () => {
  const prompts: string[] = [];
  const responses = [
    "not json",
    JSON.stringify({ suggestions: [{ findText: "missing", replacementText: "x" }] }),
    JSON.stringify({ reply: "fixed", suggestions: [] })
  ];
  const result = await runCodexSubmissionLoop({
    initialPrompt: "do the work",
    runTurn: async (prompt) => {
      prompts.push(prompt);
      return responses.shift()!;
    },
    validateSubmission: async (submission) =>
      submission.suggestions?.length ? "Suggestion findText was not found." : null
  });
  assert.equal(result.reply, "fixed");
  assert.equal(prompts.length, 3);
  assert.match(prompts[1], /could not be parsed as JSON/i);
  assert.match(prompts[2], /findText was not found/i);
});

test("Codex reports the final validator error only after exhausting bounded correction attempts", async () => {
  let calls = 0;
  await assert.rejects(
    () => runCodexSubmissionLoop({
      initialPrompt: "do the work",
      runTurn: async () => {
        calls += 1;
        return JSON.stringify({ suggestions: [{ findText: "still missing" }] });
      },
      validateSubmission: async () => "Suggestion anchor is invalid."
    }),
    new RegExp(`after ${MAX_SUBMISSION_ATTEMPTS} attempts.*anchor is invalid`, "i")
  );
  assert.equal(calls, MAX_SUBMISSION_ATTEMPTS);
});
