import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAgentEnv, isValidEnvKey, maskSecret } from "../lib/agent-env";

test("non-allowlisted host variables are dropped", () => {
  const env = buildAgentEnv({ FOO: "bar", SECRET_THING: "x", PATH: "/usr/bin" });
  assert.equal(env.FOO, undefined);
  assert.equal(env.SECRET_THING, undefined);
  assert.equal(env.PATH, "/usr/bin");
});

test("allowlisted toolchain + auth variables pass through", () => {
  const host = {
    PATH: "/bin",
    HOME: "/home/agent",
    ANTHROPIC_API_KEY: "sk-ant-123",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-xyz",
    GITHUB_TOKEN: "ghp_abc",
    PYTHON_BIN: ".venv/bin/python",
    FOO: "bar"
  };
  const env = buildAgentEnv(host);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/agent");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-123");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-xyz");
  assert.equal(env.GITHUB_TOKEN, "ghp_abc");
  assert.equal(env.PYTHON_BIN, ".venv/bin/python");
  assert.equal(env.FOO, undefined);
});

test("parent Claude Code IPC/session vars are scrubbed, but auth + our config pass", () => {
  const env = buildAgentEnv({
    // Auth + our own config must survive:
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-xyz",
    CLAUDE_AGENT_MODEL: "opus",
    ANTHROPIC_API_KEY: "sk-ant-123",
    // A parent Claude Code's control vars must NOT leak to the nested agent CLI:
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SSE_PORT: "54321",
    CLAUDE_CODE_SESSION_ID: "abc",
    CLAUDE_CODE_EXECPATH: "/usr/bin/claude",
    CLAUDE_CODE_TMPDIR: "/tmp/claude"
  });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-xyz");
  assert.equal(env.CLAUDE_AGENT_MODEL, "opus");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-123");
  for (const denied of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_TMPDIR"
  ]) {
    assert.equal(env[denied], undefined, `${denied} must be scrubbed`);
  }
});

test("document variables are injected and override host values", () => {
  const env = buildAgentEnv({ PATH: "/bin", FOO: "bar" }, { OPENAI_API_KEY: "doc-key", PATH: "/custom" });
  assert.equal(env.OPENAI_API_KEY, "doc-key");
  assert.equal(env.PATH, "/custom");
  assert.equal(env.FOO, undefined); // still dropped — doc didn't set it
});

test("two documents get isolated environments", () => {
  const host = { PATH: "/bin" };
  const a = buildAgentEnv(host, { DOC_SECRET: "alpha" });
  const b = buildAgentEnv(host, { DOC_SECRET: "beta" });
  assert.equal(a.DOC_SECRET, "alpha");
  assert.equal(b.DOC_SECRET, "beta");
  assert.notEqual(a.DOC_SECRET, b.DOC_SECRET);
});

test("undefined host values are skipped", () => {
  const env = buildAgentEnv({ PATH: undefined, HOME: "/h" });
  assert.equal("PATH" in env, false);
  assert.equal(env.HOME, "/h");
});

test("maskSecret reveals only the edges of long secrets", () => {
  assert.equal(maskSecret("sk-ant-abcdefghijklmnop"), "sk-*****nop");
  // Short secrets are fully masked.
  assert.equal(maskSecret("short"), "*****");
  assert.equal(maskSecret("ab"), "***");
  assert.match(maskSecret("12345678"), /^\*+$/);
});

test("env key validation accepts POSIX-ish names and rejects junk", () => {
  assert.equal(isValidEnvKey("OPENAI_API_KEY"), true);
  assert.equal(isValidEnvKey("_private"), true);
  assert.equal(isValidEnvKey("A1_B2"), true);
  assert.equal(isValidEnvKey("1BAD"), false);
  assert.equal(isValidEnvKey("has space"), false);
  assert.equal(isValidEnvKey("has-dash"), false);
  assert.equal(isValidEnvKey(""), false);
});
