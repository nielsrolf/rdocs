import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyAgentConfigDirEnv,
  buildAgentEnv,
  resolveAgentConfigDir
} from "../agent-core/agent-env";

// The harness CLIs resolve their native config root from HOME when no explicit
// config dir is set — i.e. the HOST's logged-in Claude/Codex session. That is a
// host-credential leak, and with the credential broker on it also breaks runs
// outright: the CLI retries a 401 with the host token, the broker only accepts
// its per-run virtual key, and the run dies with
// "Credential broker: Missing or malformed broker token."

test("resolveAgentConfigDir honors an explicit session dir", () => {
  const dir = resolveAgentConfigDir({
    harness: "claude",
    sessionConfigDir: "/agent-sessions",
    runKey: "run-1"
  });
  assert.equal(dir, "/agent-sessions");
});

test("resolveAgentConfigDir never falls back to the host home directory", () => {
  for (const harness of ["claude", "codex"] as const) {
    const dir = resolveAgentConfigDir({ harness, runKey: "run-1" });
    assert.ok(dir.startsWith(os.tmpdir()), `${harness}: ${dir} is not under tmpdir`);
    assert.ok(!dir.startsWith(os.homedir()), `${harness}: ${dir} is inside the host home`);
    assert.ok(dir.includes("run-1"));
  }
});

test("applyAgentConfigDirEnv pins one harness root and clears the other", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cfgdir-"));
  const claude = applyAgentConfigDirEnv(
    { CODEX_HOME: "/home/host/.codex" },
    { harness: "claude", sessionConfigDir: path.join(base, "claude") }
  );
  assert.equal(claude.CLAUDE_CONFIG_DIR, path.join(base, "claude"));
  assert.equal(claude.CODEX_HOME, undefined);
  assert.ok(fs.existsSync(path.join(base, "claude")));

  const codex = applyAgentConfigDirEnv(
    { CLAUDE_CONFIG_DIR: "/home/host/.claude" },
    { harness: "codex", sessionConfigDir: path.join(base, "codex") }
  );
  assert.equal(codex.CODEX_HOME, path.join(base, "codex"));
  assert.equal(codex.CLAUDE_CONFIG_DIR, undefined);
});

test("a host Claude session is never used as a credential fallback", async (t) => {
  // Drives the REAL bundled Claude CLI against a fake Anthropic endpoint that
  // always 401s, with a HOME holding a (fake) logged-in Claude session. Every
  // request must carry the injected run credential — the pre-fix CLI retried
  // with the host session token instead.
  let sdk: typeof import("@anthropic-ai/claude-agent-sdk");
  try {
    sdk = await import("@anthropic-ai/claude-agent-sdk");
  } catch {
    t.skip("claude-agent-sdk not installed");
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cfg-leak-"));
  const fakeHome = path.join(tmp, "home");
  const hostToken = "sk-ant-oat01-HOSTSESSIONTOKEN";
  fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: hostToken,
        refreshToken: "sk-ant-ort01-HOSTREFRESH",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        scopes: ["user:inference"],
        subscriptionType: "max"
      }
    })
  );

  const presented: string[] = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers["authorization"];
    const apiKey = req.headers["x-api-key"];
    if (typeof auth === "string") presented.push(auth.replace(/^Bearer\s+/i, ""));
    if (typeof apiKey === "string") presented.push(apiKey);
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Credential broker: Missing or malformed broker token." }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const brokerUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  const virtualToken = `rdocs-vk-${"a".repeat(48)}`;
  const env = applyAgentConfigDirEnv(
    buildAgentEnv(
      { PATH: process.env.PATH, HOME: fakeHome, USER: process.env.USER },
      { CLAUDE_CODE_OAUTH_TOKEN: virtualToken, ANTHROPIC_BASE_URL: brokerUrl }
    ),
    { harness: "claude", sessionConfigDir: path.join(tmp, "session") }
  );

  try {
    for await (const _message of sdk.query({
      prompt: "say hi",
      options: { env, cwd: tmp, maxTurns: 1, permissionMode: "bypassPermissions" }
    })) {
      // The fake endpoint always 401s; we only care about what was presented.
    }
  } catch {
    // Expected: the run fails to authenticate against the always-401 endpoint.
  } finally {
    server.close();
  }

  assert.ok(presented.length > 0, "the CLI never reached the fake endpoint");
  const leaked = presented.filter((value) => value.includes("HOST"));
  assert.deepEqual(leaked, [], `host session credential was sent upstream: ${leaked.join(", ")}`);
  assert.ok(
    presented.some((value) => value === virtualToken),
    `the injected run credential was never used (saw: ${presented.join(", ")})`
  );
});
