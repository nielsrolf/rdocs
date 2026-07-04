import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildContainerEnv,
  buildContainerRunArgs,
  serializeEnvFile
} from "../lib/agent-runner/container-args";

const WS = "/repo/.research-workspaces/doc-1/worktrees/run-1";
const ENVFILE = "/tmp/gdocs-agent-x/env";

function args(overrides = {}) {
  return buildContainerRunArgs({
    image: "gdocs-agent:local",
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

test("the ONLY host path mounted is the document workspace", () => {
  const a = args();
  const mounts = a.filter((_, i) => a[i - 1] === "-v");
  assert.deepEqual(mounts, [`${WS}:/workspace`]);
  // No docker socket, no extra binds, no host home.
  assert.ok(!a.join(" ").includes("docker.sock"));
  assert.ok(!a.join(" ").includes(":/host"));
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
    { MY_DOC_SECRET: "doc-secret" }
  );

  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-123");
  assert.equal(env.GITHUB_TOKEN, "gh-456");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.MY_DOC_SECRET, "doc-secret");
  // host filesystem vars removed (the container supplies its own):
  assert.ok(!("PATH" in env));
  assert.ok(!("HOME" in env));
  assert.ok(!("NODE_EXTRA_CA_CERTS" in env));
  assert.ok(!("XDG_CACHE_HOME" in env));
  // host's own non-allowlisted secret never leaks (agent-env allowlist):
  assert.ok(!("AWS_SECRET_ACCESS_KEY" in env));
});

test("buildContainerEnv drops empty values (so an empty ANTHROPIC_API_KEY can't shadow the OAuth token)", () => {
  const env = buildContainerEnv(
    { ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "tok", LANG: "  " },
    {}
  );
  assert.ok(!("ANTHROPIC_API_KEY" in env));
  assert.ok(!("LANG" in env));
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "tok");
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

test("serializeEnvFile emits VAR=VALUE lines and skips multiline values", () => {
  const text = serializeEnvFile({ A: "1", B: "two words", BAD: "line1\nline2" });
  const lines = text.trimEnd().split("\n");
  assert.ok(lines.includes("A=1"));
  assert.ok(lines.includes("B=two words"));
  assert.ok(!lines.some((l) => l.startsWith("BAD=")));
});
