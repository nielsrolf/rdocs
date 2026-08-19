import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_AUTO_COMPACT_WINDOW,
  LONG_CONTEXT_AUTO_COMPACT_WINDOW,
  LONG_CONTEXT_BETA,
  OPENROUTER_BASE_URL,
  agentEnvKeysForPrompt,
  applyLongContextEnv,
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

test("every run declares an auto-compact window below the model context window", () => {
  const env = buildAgentEnv({ PATH: "/usr/bin" });
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, DEFAULT_AUTO_COMPACT_WINDOW);
  // The baseline must stay inside the CLI's accepted range AND below the 200k
  // model window, otherwise the value is clamped away and compaction keeps
  // firing too late (that is what produced "Prompt is too long" mid-session).
  const window = Number(DEFAULT_AUTO_COMPACT_WINDOW);
  assert.ok(window >= 100_000, "CLI floor is 100k");
  assert.ok(window < 200_000, "a value at/above the model window is a no-op");

  // The deployment and the document can still override it.
  assert.equal(
    buildAgentEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "120000" }).CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    "120000"
  );
  assert.equal(
    buildAgentEnv({}, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000" }).CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    "180000"
  );
});

test("the 1M-context beta raises the compaction window to 500k on Anthropic API keys", () => {
  const env = buildAgentEnv({ ANTHROPIC_API_KEY: "sk-ant-1" }, { ANTHROPIC_API_KEY: "sk-ant-1" });
  assert.deepEqual(applyLongContextEnv(env, "anthropic"), [LONG_CONTEXT_BETA]);
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, LONG_CONTEXT_AUTO_COMPACT_WINDOW);
  // 500k is only meaningful inside a 1M window, and the CLI's own ceiling is 1M.
  const window = Number(LONG_CONTEXT_AUTO_COMPACT_WINDOW);
  assert.ok(window > 200_000, "must exceed the standard model window to be worth the beta");
  assert.ok(window <= 1_000_000, "CLI ceiling is 1M");
});

test("the 1M-context beta is withheld wherever it would be silently ignored", () => {
  // OAuth/subscription auth: the CLI drops caller-provided betas outright, so a
  // 500k window would clamp back to 200k and compaction would never fire.
  const oauth = buildAgentEnv({}, { CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "sk-ant-1" });
  assert.deepEqual(applyLongContextEnv(oauth, "anthropic"), []);
  assert.equal(oauth.CLAUDE_CODE_AUTO_COMPACT_WINDOW, DEFAULT_AUTO_COMPACT_WINDOW);

  // No Anthropic credential at all (e.g. the free local-model fallback).
  const anon = buildAgentEnv({});
  assert.deepEqual(applyLongContextEnv(anon, "anthropic"), []);
  assert.equal(anon.CLAUDE_CODE_AUTO_COMPACT_WINDOW, DEFAULT_AUTO_COMPACT_WINDOW);

  // Anthropic-compatible third parties do not widen a window for this beta.
  for (const provider of ["openrouter", "litellm", "local"] as const) {
    const env = buildAgentEnv({}, { ANTHROPIC_API_KEY: "sk-ant-1" });
    assert.deepEqual(applyLongContextEnv(env, provider), [], provider);
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, DEFAULT_AUTO_COMPACT_WINDOW, provider);
  }
});

test("a deliberate window override survives the long-context upgrade", () => {
  const env = buildAgentEnv(
    { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "120000" },
    { ANTHROPIC_API_KEY: "sk-ant-1" }
  );
  assert.deepEqual(applyLongContextEnv(env, "anthropic"), [LONG_CONTEXT_BETA]);
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "120000");
});

test("host credentials are scrubbed while non-secret toolchain config passes through", () => {
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
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.PYTHON_BIN, ".venv/bin/python");
  assert.equal(env.FOO, undefined);
});

test("the Codex SDK receives its runtime-native session root", () => {
  const env = buildAgentEnv({ CODEX_HOME: "/agent-sessions", HOME: "/home/agent" });
  assert.equal(env.CODEX_HOME, "/agent-sessions");
  assert.equal(env.HOME, "/home/agent");
});

test("the Claude SDK receives the outer-container sandbox marker", () => {
  // Docker passes this to the entrypoint, which rebuilds a scrubbed env before
  // spawning Claude Code. Dropping it at that second boundary makes the CLI
  // reject bypassPermissions because Docker Desktop runs the container as root.
  const env = buildAgentEnv({ IS_SANDBOX: "1", HOME: "/home/agent" });
  assert.equal(env.IS_SANDBOX, "1");
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

test("parent Claude Code IPC/session vars and host auth are scrubbed, but our config passes", () => {
  const env = buildAgentEnv({
    // Host auth must not survive; our non-secret config should:
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
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_AGENT_MODEL, "opus");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
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

test("applyProviderEnv honors an OPENROUTER_BASE_URL override (credential broker)", () => {
  const env = applyProviderEnv(
    {
      OPENROUTER_API_KEY: "rdocs-vk-virtual",
      OPENROUTER_BASE_URL: "http://host.docker.internal:14141/api/broker/key123/"
    },
    "openrouter"
  );
  assert.equal(env.ANTHROPIC_BASE_URL, "http://host.docker.internal:14141/api/broker/key123");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "rdocs-vk-virtual");
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

test("agentEnvKeysForPrompt discloses document env + host config key NAMES only", () => {
  const documentEnv = { OPENAI_API_KEY: "sk-openai", GITHUB_TOKEN: "ghp_doc", EMPTY_ONE: "  " };
  const finalEnv = buildAgentEnv(
    { PATH: "/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk-ant", LITELLM_BASE_URL: "http://litellm" },
    documentEnv
  );
  const keys = agentEnvKeysForPrompt(documentEnv, finalEnv);
  // Document-configured keys and the LiteLLM host default are disclosed…
  assert.deepEqual(keys, ["GITHUB_TOKEN", "LITELLM_BASE_URL", "OPENAI_API_KEY"]);
  // …but never toolchain noise or harness credentials, and never any value.
  assert.equal(keys.includes("PATH"), false);
  assert.equal(keys.includes("ANTHROPIC_API_KEY"), false);
  assert.equal(keys.includes("EMPTY_ONE"), false, "empty values are not disclosed");
});

test("agentEnvKeysForPrompt drops keys applyProviderEnv cleared in the final env", () => {
  // A user-credential ANTHROPIC_API_KEY in the document env gets cleared by
  // applyProviderEnv for litellm runs — the prompt must not claim it exists.
  const documentEnv = {
    ANTHROPIC_API_KEY: "sk-ant-doc",
    LITELLM_API_KEY: "sk-litellm",
    LITELLM_BASE_URL: "https://litellm.example.com"
  };
  const finalEnv = applyProviderEnv(buildAgentEnv({ PATH: "/bin" }, documentEnv), "litellm");
  const keys = agentEnvKeysForPrompt(documentEnv, finalEnv);
  assert.equal(keys.includes("ANTHROPIC_API_KEY"), false);
  assert.deepEqual(keys, ["LITELLM_API_KEY", "LITELLM_BASE_URL"]);
});
