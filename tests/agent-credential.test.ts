import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  hasAnthropicCredential,
  readHostClaudeOAuth,
  resolveAgentCredentialEnv,
  resolveContainerCredentialEnv
} from "../lib/agent-runner/agent-credential";

// Create a throwaway HOME containing ~/.claude/.credentials.json with the given
// OAuth payload; returns the home dir (caller removes it).
function makeHomeWithCreds(oauth: Record<string, unknown> | null): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "agent-cred-"));
  if (oauth) {
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: oauth })
    );
  }
  return home;
}

test("hasAnthropicCredential detects env credentials and ignores blanks", () => {
  assert.equal(hasAnthropicCredential({ ANTHROPIC_API_KEY: "sk-1" }), true);
  assert.equal(hasAnthropicCredential({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }), true);
  assert.equal(hasAnthropicCredential({ ANTHROPIC_API_KEY: "   " }), false);
  assert.equal(hasAnthropicCredential({}), false);
});

test("readHostClaudeOAuth extracts the access token, or returns null when absent", () => {
  const home = makeHomeWithCreds({ accessToken: "oauth-abc", expiresAt: 123 });
  try {
    assert.deepEqual(readHostClaudeOAuth({ homeDir: home }), { token: "oauth-abc", expiresAt: 123 });
    assert.equal(readHostClaudeOAuth({ homeDir: "/nonexistent/path" }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveAgentCredentialEnv prefers an existing env credential", () => {
  const { added, warning } = resolveAgentCredentialEnv(
    { ANTHROPIC_API_KEY: "sk-1" },
    { homeDir: "/nonexistent" }
  );
  assert.deepEqual(added, {});
  assert.equal(warning, null);
});

test("resolveAgentCredentialEnv falls back to the host OAuth token (with expiry warning)", () => {
  const home = makeHomeWithCreds({ accessToken: "oauth-xyz", expiresAt: 9_000 });
  try {
    const fresh = resolveAgentCredentialEnv({}, { homeDir: home, now: 1_000 });
    assert.deepEqual(fresh.added, { CLAUDE_CODE_OAUTH_TOKEN: "oauth-xyz" });
    assert.equal(fresh.warning, null);

    const expired = resolveAgentCredentialEnv({}, { homeDir: home, now: 10_000 });
    assert.deepEqual(expired.added, { CLAUDE_CODE_OAUTH_TOKEN: "oauth-xyz" });
    assert.match(expired.warning ?? "", /expired/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveAgentCredentialEnv warns when no credential is available", () => {
  const { added, warning } = resolveAgentCredentialEnv({}, { homeDir: "/nonexistent/home" });
  assert.deepEqual(added, {});
  assert.match(warning ?? "", /no Anthropic credential/i);
});

test("resolveContainerCredentialEnv never injects the host OAuth token for OpenRouter jobs", () => {
  const home = makeHomeWithCreds({ accessToken: "oauth-xyz", expiresAt: 9_000 });
  try {
    // Key present: nothing added, no warning — the container authenticates
    // with the document's OPENROUTER_API_KEY alone.
    const withKey = resolveContainerCredentialEnv(
      { OPENROUTER_API_KEY: "sk-or-v1-abc" },
      "openrouter/openai/gpt-5.2",
      { homeDir: home, now: 1_000 }
    );
    assert.deepEqual(withKey.added, {});
    assert.equal(withKey.warning, null);

    // Key missing: still nothing injected (the run fails honestly inside the
    // sandbox instead of silently billing the host Anthropic account).
    const withoutKey = resolveContainerCredentialEnv({}, "openrouter/openai/gpt-5.2", {
      homeDir: home,
      now: 1_000
    });
    assert.deepEqual(withoutKey.added, {});
    assert.match(withoutKey.warning ?? "", /OPENROUTER_API_KEY/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveContainerCredentialEnv keeps the Anthropic fallback for non-OpenRouter jobs", () => {
  const home = makeHomeWithCreds({ accessToken: "oauth-xyz", expiresAt: 9_000 });
  try {
    for (const model of ["claude-sonnet-5", "sonnet", null, undefined]) {
      const { added } = resolveContainerCredentialEnv({}, model, { homeDir: home, now: 1_000 });
      assert.deepEqual(added, { CLAUDE_CODE_OAUTH_TOKEN: "oauth-xyz" }, `model=${String(model)}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
