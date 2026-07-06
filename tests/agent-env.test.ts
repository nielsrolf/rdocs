import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OPENROUTER_BASE_URL,
  applyProviderEnv,
  buildAgentEnv,
  isValidEnvKey,
  maskSecret
} from "../lib/agent-env";

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
    PYTHON_BIN: ".venv/bin/python",
    FOO: "bar"
  };
  const env = buildAgentEnv(host);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/agent");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-123");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-xyz");
  assert.equal(env.PYTHON_BIN, ".venv/bin/python");
  assert.equal(env.FOO, undefined);
});

test("host GitHub tokens never leak into the agent env; doc-resolved ones do", () => {
  // The host GITHUB_TOKEN is the shared bot account. Handing it to every
  // (untrusted) agent run lets any user read/push every repo the bot can see.
  // GitHub auth must arrive via the per-document resolution (doc env → user
  // PAT → allowlisted host), injected as documentEnv — never the host allowlist.
  const host = { PATH: "/bin", GITHUB_TOKEN: "ghp_host", GH_TOKEN: "ghp_host" };
  const env = buildAgentEnv(host);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);

  const withDocToken = buildAgentEnv(host, { GITHUB_TOKEN: "ghp_doc", GH_TOKEN: "ghp_doc" });
  assert.equal(withDocToken.GITHUB_TOKEN, "ghp_doc");
  assert.equal(withDocToken.GH_TOKEN, "ghp_doc");
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

test("applyProviderEnv rewrites the env to OpenRouter's compat endpoint", () => {
  const env = applyProviderEnv(
    {
      OPENROUTER_API_KEY: "sk-or-v1-abc",
      ANTHROPIC_API_KEY: "sk-ant-host",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-host",
      PATH: "/bin"
    },
    "openrouter"
  );
  assert.equal(env.ANTHROPIC_BASE_URL, OPENROUTER_BASE_URL);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-or-v1-abc");
  // The host Anthropic credentials must not survive: an empty ANTHROPIC_API_KEY
  // (treated as unset by the CLI) guarantees the host key can't leak through,
  // and the OAuth token is removed so it can't win auth precedence.
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in env, false);
  // The key stays available to agent tools (e.g. scripts calling OpenRouter).
  assert.equal(env.OPENROUTER_API_KEY, "sk-or-v1-abc");
  assert.equal(env.PATH, "/bin");
});

test("applyProviderEnv throws a clear error when the OpenRouter key is missing", () => {
  for (const env of [{}, { OPENROUTER_API_KEY: "" }, { OPENROUTER_API_KEY: "   " }]) {
    assert.throws(() => applyProviderEnv(env as Record<string, string>, "openrouter"), /OPENROUTER_API_KEY/);
  }
});

test("applyProviderEnv is a no-op for the anthropic provider", () => {
  const input = { ANTHROPIC_API_KEY: "sk-ant-host", CLAUDE_CODE_OAUTH_TOKEN: "oauth-host" };
  const env = applyProviderEnv(input, "anthropic");
  assert.deepEqual(env, input);
});

test("applyProviderEnv does not mutate its input", () => {
  const input = { OPENROUTER_API_KEY: "sk-or-v1-abc", CLAUDE_CODE_OAUTH_TOKEN: "oauth-host" };
  applyProviderEnv(input, "openrouter");
  assert.equal(input.CLAUDE_CODE_OAUTH_TOKEN, "oauth-host");
  assert.equal("ANTHROPIC_BASE_URL" in input, false);
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

test("applyProviderEnv rewrites the env to a LiteLLM endpoint", () => {
  const env = applyProviderEnv(
    {
      LITELLM_API_KEY: "sk-litellm-abc",
      LITELLM_BASE_URL: "https://litellm.example.com/",
      ANTHROPIC_API_KEY: "sk-ant-host",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-host",
      PATH: "/bin"
    },
    "litellm"
  );
  // Trailing slash is stripped so the SDK's path-appending yields /v1/messages.
  assert.equal(env.ANTHROPIC_BASE_URL, "https://litellm.example.com");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-litellm-abc");
  // Host Anthropic credentials must not survive (same guarantees as OpenRouter).
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in env, false);
  // The key stays available to agent tools (e.g. scripts calling LiteLLM).
  assert.equal(env.LITELLM_API_KEY, "sk-litellm-abc");
  assert.equal(env.PATH, "/bin");
});

test("applyProviderEnv throws clear errors when LiteLLM key or base URL is missing", () => {
  for (const env of [{}, { LITELLM_API_KEY: "", LITELLM_BASE_URL: "https://x" }, { LITELLM_API_KEY: "   ", LITELLM_BASE_URL: "https://x" }]) {
    assert.throws(() => applyProviderEnv(env as Record<string, string>, "litellm"), /LITELLM_API_KEY/);
  }
  for (const env of [{ LITELLM_API_KEY: "sk-x" }, { LITELLM_API_KEY: "sk-x", LITELLM_BASE_URL: "  " }]) {
    assert.throws(() => applyProviderEnv(env as Record<string, string>, "litellm"), /LITELLM_BASE_URL/);
  }
});

test("host LITELLM_BASE_URL passes the allowlist but a host LITELLM_API_KEY does not", () => {
  // The base URL is configuration, not a credential — a server-wide default is
  // fine. The key must stay per-document so the host is never silently billed.
  const env = buildAgentEnv({
    LITELLM_BASE_URL: "http://host.docker.internal:9274",
    LITELLM_API_KEY: "sk-host-litellm"
  });
  assert.equal(env.LITELLM_BASE_URL, "http://host.docker.internal:9274");
  assert.equal(env.LITELLM_API_KEY, undefined);
});
