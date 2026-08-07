import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hasAnthropicCredential,
  resolveAgentCredentialEnv,
  resolveContainerCredentialEnv
} from "../lib/agent-runner/agent-credential";

test("hasAnthropicCredential detects explicitly resolved credentials and ignores blanks", () => {
  assert.equal(hasAnthropicCredential({ ANTHROPIC_API_KEY: "sk-1" }), true);
  assert.equal(hasAnthropicCredential({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }), true);
  assert.equal(hasAnthropicCredential({ ANTHROPIC_API_KEY: "   " }), false);
  assert.equal(hasAnthropicCredential({}), false);
});

test("resolved Anthropic credentials pass through unchanged", () => {
  const result = resolveAgentCredentialEnv({ ANTHROPIC_API_KEY: "sk-account" });
  assert.deepEqual(result, { added: {}, warning: null, error: null });
});

test("missing Anthropic credentials fail without inspecting host login files", () => {
  const result = resolveAgentCredentialEnv({}, {
    homeDir: "/host-home-that-must-never-be-read",
    credentialsPath: "/host/.claude/.credentials.json"
  });
  assert.deepEqual(result.added, {});
  assert.equal(result.warning, null);
  assert.match(result.error ?? "", /connect an Anthropic credential.*settings/i);
  assert.doesNotMatch(result.error ?? "", /host|\.claude|run `claude`/i);
});

test("provider-key containers never fall back to host credentials", () => {
  const withKey = resolveContainerCredentialEnv(
    { LITELLM_API_KEY: "sk-litellm" },
    "codex/litellm/openai/gpt-5.6-terra",
    { homeDir: "/host-home" }
  );
  assert.deepEqual(withKey, { added: {}, warning: null, error: null });

  const missing = resolveContainerCredentialEnv({}, "codex/litellm/openai/gpt-5.6-terra", {
    homeDir: "/host-home"
  });
  assert.deepEqual(missing.added, {});
  assert.match(missing.warning ?? "", /LITELLM_API_KEY/);
});

test("native Codex requires an explicitly resolved account or document OpenAI key", () => {
  const withKey = resolveContainerCredentialEnv(
    { OPENAI_API_KEY: "sk-account" },
    "codex/openai/gpt-5.6-terra"
  );
  assert.deepEqual(withKey, { added: {}, warning: null, error: null });

  const missing = resolveContainerCredentialEnv({}, "codex/openai/gpt-5.6-terra", {
    homeDir: "/host-home"
  });
  assert.deepEqual(missing.added, {});
  assert.match(missing.error ?? "", /connect an OpenAI credential.*AI settings/i);
  assert.doesNotMatch(missing.error ?? "", /host|codex login/i);
});

test("Anthropic containers require an explicitly resolved account or document credential", () => {
  const missing = resolveContainerCredentialEnv({}, "claude-sonnet-5", {
    homeDir: "/host-home"
  });
  assert.deepEqual(missing.added, {});
  assert.match(missing.error ?? "", /connect an Anthropic credential.*settings/i);
  assert.doesNotMatch(missing.error ?? "", /host|run `claude`/i);
});
