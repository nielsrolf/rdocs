import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemPrompt, type ClaudeResearchAgentInput } from "../agent-core/agent";
import { toolsForAgentAccess } from "../agent-core/ai-tools";
import { restrictAgentEnvForReadOnly } from "../lib/user-credentials";

test("read-only agent access has research tools but no workspace mutation tools", () => {
  const tools = toolsForAgentAccess("read_only");
  assert.ok(tools.includes("Read"));
  assert.ok(tools.includes("WebSearch"));
  for (const mutating of ["Write", "Edit", "MultiEdit", "Bash"]) {
    assert.ok(!tools.includes(mutating), `${mutating} must not be available`);
  }
});

test("read-only share runs receive model credentials but not document or GitHub secrets", () => {
  const env = restrictAgentEnvForReadOnly({
    ANTHROPIC_API_KEY: "model-key",
    OPENROUTER_API_KEY: "router-key",
    GITHUB_TOKEN: "repo-token",
    GH_TOKEN: "repo-token",
    DATABASE_URL: "secret-db",
    CUSTOM_TEAM_SECRET: "secret"
  });
  assert.equal(env.ANTHROPIC_API_KEY, "model-key");
  assert.equal(env.OPENROUTER_API_KEY, "router-key");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.CUSTOM_TEAM_SECRET, undefined);
});

test("the read-only system prompt accurately describes the enforced boundary", () => {
  const input: ClaudeResearchAgentInput = {
    mode: "comment_reply",
    accessMode: "read_only",
    documentTitle: "Shared doc",
    documentText: "Body",
    unresolvedThreads: [],
    workspacePath: "/workspace",
    workspaceOverview: "README.md",
    instruction: "Answer",
    comments: []
  };
  const prompt = buildSystemPrompt(input);
  assert.match(prompt, /read-only/i);
  assert.doesNotMatch(prompt, /freely Write\/Edit\/Bash/);
  assert.doesNotMatch(prompt, /auto-commits whatever changed/);
});
