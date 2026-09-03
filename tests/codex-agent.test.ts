import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODEX_SUBMISSION_JSON_SCHEMA,
  MAX_SUBMISSION_ATTEMPTS,
  codexProviderConfig,
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

test("Codex falls back to CLAUDE.md wherever a directory has no AGENTS.md", () => {
  // Codex only reads AGENTS.md natively. Workspaces (and the Slack notebook
  // convention) use CLAUDE.md, so switching a document from Claude Code to
  // Codex must not silently drop those instructions. Codex's own
  // `project_doc_fallback_filenames` implements exactly the rule we want —
  // "if there is a CLAUDE.md but no AGENTS.md, read CLAUDE.md" — without
  // writing an AGENTS.md into the workspace (which would be auto-committed and
  // would break the "harness selection never changes workspace content" rule).
  for (const provider of ["openai", "litellm"] as const) {
    const configured = codexProviderConfig(
      provider,
      { OPENAI_API_KEY: "test", LITELLM_API_KEY: "test", LITELLM_BASE_URL: "http://litellm.local" },
      undefined
    );
    assert.deepEqual(configured.config.project_doc_fallback_filenames, ["CLAUDE.md"]);
  }
});

test("Codex structured output schema requires every top-level field", () => {
  const required = new Set((CODEX_SUBMISSION_JSON_SCHEMA as { required?: string[] }).required ?? []);
  assert.deepEqual(
    required,
    new Set(["replacementText", "reply", "sources", "images", "widgets", "summary", "suggestions", "comments"])
  );
  assert.equal((CODEX_SUBMISSION_JSON_SCHEMA as { additionalProperties?: boolean }).additionalProperties, false);
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
