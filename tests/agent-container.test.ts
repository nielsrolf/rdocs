import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildContainerEnv,
  buildContainerRunArgs,
  resolveContainerUser,
  serializeEnvFile
} from "../lib/agent-runner/container-args";
import { classifyContainerFailure } from "../lib/agent-runner/container";
import { DEFAULT_AUTO_COMPACT_WINDOW } from "../agent-core/agent-env";

const WS = "/repo/.research-workspaces/doc-1/worktrees/run-1";
const ENVFILE = "/tmp/gdocs-agent-x/env";

function args(overrides = {}) {
  return buildContainerRunArgs({
    image: "gdocs-agent:local",
    agentHarness: "claude-code",
    workspaceHostPath: WS,
    envFileHostPath: ENVFILE,
    uid: 501,
    gid: 20,
    memory: "4g",
    pidsLimit: 512,
    ...overrides
  });
}

test("container run args enforce the hardening profile", () => {
  const a = args();
  const joined = a.join(" ");
  assert.equal(a[0], "run");
  assert.ok(a.includes("--rm"));
  assert.ok(a.includes("-i"));
  assert.ok(joined.includes("--user 501:20"));
  assert.ok(joined.includes("--cap-drop ALL"));
  assert.ok(joined.includes("--security-opt no-new-privileges"));
  assert.ok(a.includes("--read-only"));
  assert.ok(joined.includes("--pids-limit 512"));
  assert.ok(joined.includes("--memory 4g"));
  // The image is the last argument.
  assert.equal(a[a.length - 1], "gdocs-agent:local");
});

test("Docker Desktop runs as container root so its root-owned bind mounts stay writable", () => {
  assert.deepEqual(resolveContainerUser("darwin", 505, 20), { uid: undefined, gid: undefined });
  assert.deepEqual(resolveContainerUser("linux", 1001, 1001), { uid: 1001, gid: 1001 });
});

test("root-run Claude container identifies the hardened outer container as its sandbox", () => {
  const containerUser = resolveContainerUser("darwin", 505, 20);
  const a = args({ ...containerUser, agentHarness: "claude-code" });
  assert.ok(!a.includes("--user"), "Docker Desktop bind mounts require container root");
  assert.ok(
    a.some((value, index) => value === "IS_SANDBOX=1" && a[index - 1] === "-e"),
    "Claude Code otherwise rejects bypassPermissions when its effective uid is root"
  );
});

test("Codex container does not receive Claude's sandbox compatibility marker", () => {
  const a = args({ agentHarness: "codex", image: "gdocs-codex-agent:local" });
  assert.ok(!a.includes("IS_SANDBOX=1"));
});

test("the ONLY host path mounted is the document workspace", () => {
  const a = args();
  const mounts = a.filter((_, i) => a[i - 1] === "-v");
  assert.deepEqual(mounts, [`${WS}:/workspace`]);
  // No docker socket, no extra binds, no host home.
  assert.ok(!a.join(" ").includes("docker.sock"));
  assert.ok(!a.join(" ").includes(":/host"));
});

test("Claude and Codex mount the exact same prepared workspace", () => {
  const claude = args({ agentHarness: "claude-code", image: "gdocs-agent:local" });
  const codex = args({ agentHarness: "codex", image: "gdocs-codex-agent:local" });
  const workspaceMount = (argv: string[]) => argv[argv.indexOf("-w") + 3];
  assert.equal(workspaceMount(claude), `${WS}:/workspace`);
  assert.equal(workspaceMount(codex), `${WS}:/workspace`);
});

test("Codex session storage is mounted as CODEX_HOME without translating its native files", () => {
  const sessionDir = "/repo/.research-workspaces/doc-1/agent-sessions/conversation-1";
  const a = args({ sessionDirHostPath: sessionDir, agentHarness: "codex" });
  assert.ok(a.join(" ").includes(`-v ${sessionDir}:/agent-sessions`));
  assert.ok(a.join(" ").includes("-e CODEX_HOME=/agent-sessions"));
  assert.ok(!a.join(" ").includes("CLAUDE_CONFIG_DIR"));
});

test("Claude session storage remains mounted as CLAUDE_CONFIG_DIR", () => {
  const a = args({ sessionDirHostPath: "/tmp/claude-session", agentHarness: "claude-code" });
  assert.ok(a.join(" ").includes("-e CLAUDE_CONFIG_DIR=/agent-sessions"));
  assert.ok(!a.join(" ").includes("CODEX_HOME"));
});

test("egress is allowed (never --network none)", () => {
  const network = args()[args().indexOf("--network") + 1];
  assert.equal(network, "bridge");
  assert.notEqual(network, "none");
});

test("ociRuntime selects --runtime when set (e.g. gVisor), and is absent otherwise", () => {
  assert.ok(!args().includes("--runtime"));
  const a = args({ ociRuntime: "runsc" });
  const i = a.indexOf("--runtime");
  assert.ok(i >= 0, "--runtime present");
  assert.equal(a[i + 1], "runsc");
  // It must come before the image (a run flag, not an arg to the container).
  assert.ok(i < a.indexOf("gdocs-agent:local"));
});

test("read-only can be disabled but tmpfs scratch only appears when read-only", () => {
  assert.ok(!args({ readOnly: false }).includes("--read-only"));
  assert.ok(!args({ readOnly: false }).join(" ").includes("--tmpfs"));
  assert.ok(args({ readOnly: true }).join(" ").includes("--tmpfs /tmp"));
});

test("buildContainerEnv keeps secrets/tokens but drops host filesystem vars", () => {
  const env = buildContainerEnv(
    {
      ANTHROPIC_API_KEY: "sk-ant-123",
      // The host GITHUB_TOKEN is the shared bot account — it must never reach
      // the container; per-document GitHub auth arrives via the doc env.
      GITHUB_TOKEN: "gh-456",
      LANG: "en_US.UTF-8",
      // host-filesystem vars that are wrong inside the container:
      PATH: "/Users/slacki/bin:/usr/bin",
      HOME: "/Users/slacki",
      NODE_EXTRA_CA_CERTS: "/Users/slacki/cert.pem",
      XDG_CACHE_HOME: "/Users/slacki/.cache",
      // a non-allowlisted host secret that must never reach the agent:
      AWS_SECRET_ACCESS_KEY: "should-be-dropped-by-allowlist"
    },
    { MY_DOC_SECRET: "doc-secret", GITHUB_TOKEN: "gh-doc-resolved" }
  );

  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, "gh-doc-resolved");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.MY_DOC_SECRET, "doc-secret");
  // host filesystem vars removed (the container supplies its own):
  assert.ok(!("PATH" in env));
  assert.ok(!("HOME" in env));
  assert.ok(!("NODE_EXTRA_CA_CERTS" in env));
  assert.ok(!("XDG_CACHE_HOME" in env));
  // host's own non-allowlisted secret never leaks (agent-env allowlist):
  assert.ok(!("AWS_SECRET_ACCESS_KEY" in env));
  // the compaction window must reach the containerized CLI, or the container
  // runner keeps compacting too late while in-process runs don't. This is the
  // conservative baseline; agent-core raises it to the long-context window
  // in-container, once the run's credential shape is known.
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, DEFAULT_AUTO_COMPACT_WINDOW);
});

test("buildContainerEnv never inherits host Anthropic credentials", () => {
  const env = buildContainerEnv(
    { ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "tok", LANG: "  " },
    {}
  );
  assert.ok(!("ANTHROPIC_API_KEY" in env));
  assert.ok(!("LANG" in env));
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("a document OPENROUTER_API_KEY reaches the container env file intact", () => {
  // The in-container agent translates OPENROUTER_API_KEY into the SDK's
  // ANTHROPIC_* vars (applyProviderEnv), so the key itself must survive the
  // host-side env-file path.
  const env = buildContainerEnv({ LANG: "C" }, { OPENROUTER_API_KEY: "sk-or-v1-abc" });
  assert.equal(env.OPENROUTER_API_KEY, "sk-or-v1-abc");
  const lines = serializeEnvFile(env).trimEnd().split("\n");
  assert.ok(lines.includes("OPENROUTER_API_KEY=sk-or-v1-abc"));
});

test("OpenAI and LiteLLM keys reach a Codex container without exposing host CODEX_HOME", () => {
  const env = buildContainerEnv(
    { OPENAI_API_KEY: "host-key-must-not-leak", CODEX_HOME: "/Users/example/.codex" },
    {
      OPENAI_API_KEY: "sk-openai",
      LITELLM_API_KEY: "sk-litellm",
      LITELLM_BASE_URL: "http://litellm:4000"
    }
  );
  assert.equal(env.OPENAI_API_KEY, "sk-openai");
  assert.equal(env.LITELLM_API_KEY, "sk-litellm");
  assert.equal(env.LITELLM_BASE_URL, "http://litellm:4000");
  assert.ok(!("CODEX_HOME" in env));
});

test("classifyContainerFailure never retries host auth and gives account-scoped guidance", () => {
  const authErr = new Error("Failed to authenticate. API Error: 401 Invalid authentication credentials");
  const second = classifyContainerFailure(authErr, {
    usesProviderKey: false,
    authRetried: false,
    transientAttempt: 0
  });
  assert.equal(second.action, "auth-fail");
  assert.match(second.action === "auth-fail" ? second.message : "", /connect.*credential.*settings/i);
  assert.doesNotMatch(second.action === "auth-fail" ? second.message : "", /host|run `claude`/i);
});

test("classifyContainerFailure never uses native host Codex auth", () => {
  const authErr = new Error("unexpected status 401 Unauthorized: Missing bearer");
  const final = classifyContainerFailure(authErr, {
    harness: "codex",
    usesProviderKey: false,
    authRetried: false,
    transientAttempt: 0
  });
  assert.equal(final.action, "auth-fail");
  assert.match(final.action === "auth-fail" ? final.message : "", /connect.*OpenAI.*Settings/i);
  assert.doesNotMatch(final.action === "auth-fail" ? final.message : "", /host|codex login/i);
});

test("classifyContainerFailure never re-resolves a 401 for OpenRouter jobs (durable key)", () => {
  const authErr = new Error("API Error: 401 Invalid authentication credentials");
  const decision = classifyContainerFailure(authErr, {
    usesProviderKey: true,
    authRetried: false,
    transientAttempt: 0
  });
  assert.equal(decision.action, "auth-fail");
});

test("classifyContainerFailure retries transient container failures with escalating backoff, then throws", () => {
  const spawnErr = new Error("agent container spawn failed: spawn docker ENOENT");
  const first = classifyContainerFailure(spawnErr, {
    usesProviderKey: false,
    authRetried: false,
    transientAttempt: 0,
    delaysMs: [2_000, 8_000]
  });
  assert.deepEqual(first, { action: "transient-retry", delayMs: 2_000 });
  const second = classifyContainerFailure(spawnErr, {
    usesProviderKey: false,
    authRetried: false,
    transientAttempt: 1,
    delaysMs: [2_000, 8_000]
  });
  assert.deepEqual(second, { action: "transient-retry", delayMs: 8_000 });
  // Budget exhausted.
  assert.deepEqual(
    classifyContainerFailure(spawnErr, {
      usesProviderKey: false,
      authRetried: false,
      transientAttempt: 2,
      delaysMs: [2_000, 8_000]
    }),
    { action: "throw" }
  );
});

test("classifyContainerFailure throws (no retry) on a non-transient, non-auth failure", () => {
  const decision = classifyContainerFailure(new Error("replacementText must not be empty"), {
    usesProviderKey: false,
    authRetried: false,
    transientAttempt: 0
  });
  assert.deepEqual(decision, { action: "throw" });
});

test("serializeEnvFile emits VAR=VALUE lines and skips multiline values", () => {
  const text = serializeEnvFile({ A: "1", B: "two words", BAD: "line1\nline2" });
  const lines = text.trimEnd().split("\n");
  assert.ok(lines.includes("A=1"));
  assert.ok(lines.includes("B=two words"));
  assert.ok(!lines.some((l) => l.startsWith("BAD=")));
});
