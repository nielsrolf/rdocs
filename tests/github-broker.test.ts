import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { promisify } from "node:util";

process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

import { ensureGithubBrokerBridge, githubBrokerSegmentForHost, stopGithubBrokerBridge } from "../agent-core/github-broker-bridge";
import { db } from "../lib/db";
import {
  appendGitConfigEnv,
  brokerizeAgentEnvForRun,
  githubUpstream,
  isVirtualBrokerToken,
  planBrokerRewrites
} from "../lib/credential-broker";
import { extractPresentedToken, handleBrokerProxyRequest } from "../lib/credential-broker/proxy";

const run = promisify(execFile);
// Shaped like a real classic token on purpose: the assertions below look for it everywhere.
const REAL = `ghp_${"r3alT0kenForTheBrokerTest".padEnd(36, "x")}`;
const created = { users: [] as string[], documents: [] as string[] };
const tmpDirs: string[] = [];

function tmp(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function makeRun() {
  const user = await db.user.create({
    data: { email: `ghbroker-${crypto.randomUUID()}@example.com`, name: "gh", passwordHash: "x" }
  });
  created.users.push(user.id);
  const doc = await db.document.create({
    data: { title: "gh broker", content: JSON.stringify({ type: "doc", content: [] }), ownerId: user.id }
  });
  created.documents.push(doc.id);
  return db.aiRun.create({
    data: { documentId: doc.id, triggerType: "CONVERSATION", instruction: "t", status: "RUNNING" }
  });
}

test.after(async () => {
  await stopGithubBrokerBridge();
  await db.document.deleteMany({ where: { id: { in: created.documents } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
  await db.$disconnect();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for GitHub on one host: /api/v3/* answers JSON to the right
 * Bearer token, everything else is a real smart-HTTP git server (git
 * http-backend) that only serves the right Basic credential.
 */
async function startFakeGithub(projectRoot: string) {
  const seen: { method: string; url: string; authorization?: string }[] = [];
  const basic = `Basic ${Buffer.from(`x-access-token:${REAL}`).toString("base64")}`;
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
    const url = new URL(req.url ?? "/", "http://fake");
    if (url.pathname.startsWith("/api/v3/")) {
      if (req.headers.authorization !== `Bearer ${REAL}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ message: "Bad credentials" }));
        return;
      }
      if (url.pathname === "/api/v3/moved") {
        res.writeHead(302, { location: `http://${req.headers.host}/api/v3/user` }).end();
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        link: `<http://${req.headers.host}/api/v3/user?page=2>; rel="next"`
      });
      res.end(JSON.stringify({ login: "octo-test", path: url.pathname }));
      return;
    }
    if (req.headers.authorization !== basic) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' }).end("auth required");
      return;
    }
    const cgi = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
        HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1"
      } as unknown as NodeJS.ProcessEnv
    });
    req.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    cgi.on("close", () => {
      const output = Buffer.concat(chunks);
      const split = output.indexOf("\r\n\r\n");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of output.subarray(0, split).toString().split("\r\n")) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === "status") status = Number.parseInt(value, 10);
        else headers[name] = value;
      }
      res.writeHead(status, headers).end(output.subarray(split + 4));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, seen, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** The broker route as the app serves it, on a real socket (what git and gh talk to). */
async function startBrokerFront(env: Record<string, string | undefined>) {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const [, , , keyId, ...segments] = url.pathname.split("/");
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const hasBody = !["GET", "HEAD"].includes(req.method ?? "GET");
      const request = new Request(url, {
        method: req.method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
        // @ts-expect-error node fetch needs duplex for request bodies
        duplex: "half"
      });
      const response = await handleBrokerProxyRequest(request, keyId, segments.map(decodeURIComponent), { env });
      const out: Record<string, string> = {};
      response.headers.forEach((value, name) => (out[name] = value));
      res.writeHead(response.status, out);
      if (response.body) Readable.fromWeb(response.body as never).pipe(res);
      else res.end();
    })().catch((error) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("the plan replaces both GitHub variables and never leaves the real token in the env", () => {
  const plans = planBrokerRewrites({ GH_TOKEN: REAL }, "claude-sonnet-5", { hostEnv: {} });
  const github = plans.find((plan) => plan.provider === "github");
  assert.ok(github);
  assert.equal(github.envKey, "GITHUB_TOKEN");
  assert.deepEqual(github.aliasEnvKeys, ["GH_TOKEN"]);
  assert.equal(github.upstreamBaseUrl, "https://github.com");
  assert.deepEqual(github.extraEnv("http://b/api/broker/k"), {
    RDOCS_GITHUB_BROKER_URL: "http://b/api/broker/k",
    GITHUB_API_URL: "http://b/api/broker/k/api",
    GITHUB_GRAPHQL_URL: "http://b/api/broker/k/api/graphql"
  });
  const config = github.gitConfig!("http://b/api/broker/k", "rdocs-vk-abc");
  assert.deepEqual(config, [
    ["url.http://b/api/broker/k/git/.insteadOf", "https://github.com/"],
    ["http.http://b/api/broker/k/.extraheader", "Authorization: Bearer rdocs-vk-abc"]
  ]);
  assert.ok(!JSON.stringify(config).includes(REAL));
  // An already virtual token (a retried run) is not brokered twice.
  assert.equal(
    planBrokerRewrites({ GITHUB_TOKEN: "rdocs-vk-abc" }, "claude-sonnet-5", { hostEnv: {} }).some((p) => p.provider === "github"),
    false
  );
});

test("git config is appended after what the env already configures", () => {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" };
  appendGitConfigEnv(env, [["a.b", "1"], ["c.d", "2"]]);
  assert.equal(env.GIT_CONFIG_COUNT, "3");
  assert.equal(env.GIT_CONFIG_KEY_0, "user.name");
  assert.equal(env.GIT_CONFIG_KEY_2, "c.d");
});

test("GitHub endpoints and the auth each one takes", () => {
  assert.deepEqual(githubUpstream("https://github.com", "git"), { baseUrl: "https://github.com", auth: "basic" });
  assert.deepEqual(githubUpstream("https://github.com/", "api"), { baseUrl: "https://api.github.com", auth: "bearer" });
  assert.deepEqual(githubUpstream("https://github.com", "raw"), { baseUrl: "https://raw.githubusercontent.com", auth: "bearer" });
  assert.deepEqual(githubUpstream("https://ghe.example", "api"), { baseUrl: "https://ghe.example/api/v3", auth: "bearer" });
  assert.equal(githubUpstream("https://github.com", "v1"), null);
  assert.equal(githubBrokerSegmentForHost("api.github.com"), "api");
  assert.equal(githubBrokerSegmentForHost("GitHub.com:443"), "git");
  assert.equal(githubBrokerSegmentForHost("example.com"), null);
});

test("the virtual token is accepted in every form GitHub clients send", () => {
  const h = (value: string) => new Headers({ authorization: value });
  assert.equal(extractPresentedToken(h("Bearer rdocs-vk-1")), "rdocs-vk-1");
  assert.equal(extractPresentedToken(h("token rdocs-vk-1")), "rdocs-vk-1");
  assert.equal(extractPresentedToken(h(`Basic ${Buffer.from("x-access-token:rdocs-vk-1").toString("base64")}`)), "rdocs-vk-1");
  assert.equal(extractPresentedToken(h(`Basic ${Buffer.from("rdocs-vk-1:").toString("base64")}`)), "rdocs-vk-1");
  assert.equal(extractPresentedToken(h(`Basic ${Buffer.from("someone:password").toString("base64")}`)), null);
});

test("git clones and pushes through the broker, and the real token is nowhere in the sandbox", async () => {
  const projectRoot = tmp("gh-upstream-");
  const bare = path.join(projectRoot, "acme", "repo.git");
  fs.mkdirSync(bare, { recursive: true });
  await run("git", ["init", "--bare", "--initial-branch=main", bare]);
  await run("git", ["-C", bare, "config", "http.receivepack", "true"]);
  const seed = tmp("gh-seed-");
  const identity = ["-c", "user.name=seed", "-c", "user.email=seed@example.com"];
  await run("git", ["init", "--initial-branch=main", seed]);
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n");
  await run("git", ["-C", seed, "add", "."]);
  await run("git", ["-C", seed, ...identity, "commit", "-m", "seed"]);
  await run("git", ["-C", seed, "push", bare, "main"]);

  const github = await startFakeGithub(projectRoot);
  const front = await startBrokerFront({});
  try {
    const aiRun = await makeRun();
    const hostEnv = {
      AGENT_CREDENTIAL_BROKER: "1",
      AGENT_BROKER_BASE_URL: front.baseUrl,
      RDOCS_GITHUB_UPSTREAM: github.baseUrl
    };
    const { agentEnv, minted } = await brokerizeAgentEnvForRun(
      { GITHUB_TOKEN: REAL, GH_TOKEN: REAL },
      { aiRunId: aiRun.id, agentModel: "claude-sonnet-5", hostEnv }
    );
    assert.deepEqual(minted, ["github"]);
    assert.ok(isVirtualBrokerToken(agentEnv.GITHUB_TOKEN));
    assert.equal(agentEnv.GH_TOKEN, agentEnv.GITHUB_TOKEN);
    assert.ok(!JSON.stringify(agentEnv).includes(REAL), "no part of the run env holds the real token");
    assert.ok(!JSON.stringify(agentEnv).includes(Buffer.from(`x-access-token:${REAL}`).toString("base64")));

    // The sandbox: its own HOME, only the run env.
    const home = tmp("gh-home-");
    const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_TERMINAL_PROMPT: "0", ...agentEnv } as unknown as NodeJS.ProcessEnv;
    const checkout = path.join(home, "repo");
    await run("git", ["clone", "https://github.com/acme/repo.git", checkout], { env });
    assert.equal(fs.readFileSync(path.join(checkout, "README.md"), "utf8"), "hello\n");

    fs.writeFileSync(path.join(checkout, "result.txt"), "from the agent\n");
    await run("git", ["-C", checkout, "add", "."], { env });
    await run("git", ["-C", checkout, ...identity, "commit", "-m", "agent work"], { env });
    const push = await run("git", ["-C", checkout, "push", "origin", "HEAD:main"], { env });
    const log = await run("git", ["-C", bare, "log", "--format=%s", "main"]);
    assert.deepEqual(log.stdout.trim().split("\n"), ["agent work", "seed"]);

    // What an agent would print, and what is on the sandbox's disk.
    const remotes = await run("git", ["-C", checkout, "remote", "-v"], { env });
    const printed = `${push.stdout}${push.stderr}${remotes.stdout}`;
    assert.ok(!printed.includes(REAL));
    assert.ok(!printed.includes("x-access-token"));
    assert.ok(!fs.readFileSync(path.join(checkout, ".git", "config"), "utf8").includes(REAL));
    assert.ok(!fs.existsSync(path.join(home, ".gitconfig")));

    // GitHub saw the real credential on every request, from the broker only.
    assert.ok(github.seen.length >= 4);
    assert.ok(github.seen.every((request) => request.authorization?.startsWith("Basic ")));

    // The run ends: the same sandbox can no longer reach GitHub.
    await db.aiRun.update({ where: { id: aiRun.id }, data: { status: "SUCCEEDED" } });
    await assert.rejects(run("git", ["-C", checkout, "fetch", "origin"], { env }));
  } finally {
    github.server.close();
    front.server.close();
  }
});

test("API calls go through the broker; redirects and pagination links stay on it", async () => {
  const github = await startFakeGithub(tmp("gh-upstream-"));
  const front = await startBrokerFront({});
  try {
    const aiRun = await makeRun();
    const { agentEnv } = await brokerizeAgentEnvForRun(
      { GITHUB_TOKEN: REAL },
      {
        aiRunId: aiRun.id,
        agentModel: "claude-sonnet-5",
        hostEnv: { AGENT_CREDENTIAL_BROKER: "1", AGENT_BROKER_BASE_URL: front.baseUrl, RDOCS_GITHUB_UPSTREAM: github.baseUrl }
      }
    );
    const keyUrl = agentEnv.RDOCS_GITHUB_BROKER_URL;
    const ok = await fetch(`${agentEnv.GITHUB_API_URL}/user`, { headers: { authorization: `token ${agentEnv.GITHUB_TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { login: string }).login, "octo-test");
    assert.equal(ok.headers.get("link"), `<${front.baseUrl}${new URL(keyUrl).pathname}/api/user?page=2>; rel="next"`);

    const moved = await fetch(`${agentEnv.GITHUB_API_URL}/moved`, {
      headers: { authorization: `Bearer ${agentEnv.GITHUB_TOKEN}` },
      redirect: "manual"
    });
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.get("location"), `${new URL(keyUrl).pathname}/api/user`);

    const wrong = await fetch(`${agentEnv.GITHUB_API_URL}/user`, { headers: { authorization: "Bearer rdocs-vk-not-this-one" } });
    assert.equal(wrong.status, 401);
    const unknown = await fetch(`${keyUrl}/v1/user`, { headers: { authorization: `Bearer ${agentEnv.GITHUB_TOKEN}` } });
    assert.equal(unknown.status, 404);
  } finally {
    github.server.close();
    front.server.close();
  }
});

test("gh works through the in-sandbox bridge with only the virtual token", async (t) => {
  if (spawnSync("gh", ["--version"]).status !== 0) {
    t.skip("gh is not installed here");
    return;
  }
  const github = await startFakeGithub(tmp("gh-upstream-"));
  const front = await startBrokerFront({});
  try {
    const aiRun = await makeRun();
    const { agentEnv } = await brokerizeAgentEnvForRun(
      { GITHUB_TOKEN: REAL },
      {
        aiRunId: aiRun.id,
        agentModel: "claude-sonnet-5",
        hostEnv: { AGENT_CREDENTIAL_BROKER: "1", AGENT_BROKER_BASE_URL: front.baseUrl, RDOCS_GITHUB_UPSTREAM: github.baseUrl }
      }
    );
    const bridgeEnv = await ensureGithubBrokerBridge(agentEnv);
    assert.ok(bridgeEnv.GH_CONFIG_DIR);
    assert.deepEqual(await ensureGithubBrokerBridge(agentEnv), bridgeEnv, "one bridge per broker key");
    const home = tmp("gh-home-");
    const env = { PATH: process.env.PATH ?? "", HOME: home, ...agentEnv, ...bridgeEnv } as unknown as NodeJS.ProcessEnv;
    const result = await run("gh", ["api", "user", "--jq", ".login"], { env });
    assert.equal(result.stdout.trim(), "octo-test");
    assert.ok(github.seen.some((request) => request.url === "/api/v3/user" && request.authorization === `Bearer ${REAL}`));
    assert.ok(!fs.readFileSync(path.join(bridgeEnv.GH_CONFIG_DIR, "config.yml"), "utf8").includes(REAL));
    assert.deepEqual(await ensureGithubBrokerBridge({}), {}, "no brokered GitHub access, no bridge");
  } finally {
    github.server.close();
    front.server.close();
  }
});

test("in a sandbox the routing is also written to HOME, so git and gh work without any GitHub variable in the shell", async (t) => {
  const projectRoot = tmp("gh-upstream-");
  const bare = path.join(projectRoot, "acme", "repo.git");
  fs.mkdirSync(bare, { recursive: true });
  await run("git", ["init", "--bare", "--initial-branch=main", bare]);
  const seed = tmp("gh-seed-");
  await run("git", ["init", "--initial-branch=main", seed]);
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n");
  await run("git", ["-C", seed, "add", "."]);
  await run("git", ["-C", seed, "-c", "user.name=seed", "-c", "user.email=seed@example.com", "commit", "-m", "seed"]);
  await run("git", ["-C", seed, "push", bare, "main"]);

  const github = await startFakeGithub(projectRoot);
  const front = await startBrokerFront({});
  const hostEnv = { AGENT_CREDENTIAL_BROKER: "1", AGENT_BROKER_BASE_URL: front.baseUrl, RDOCS_GITHUB_UPSTREAM: github.baseUrl };
  try {
    const home = tmp("gh-home-");
    // What a harness that filters variables named like KEY or TOKEN leaves its shell.
    const bareEnv = { PATH: process.env.PATH ?? "", HOME: home, GIT_TERMINAL_PROMPT: "0" } as unknown as NodeJS.ProcessEnv;
    let previousRoute = "";
    for (const round of [1, 2]) {
      // Two runs in the same session container: the second replaces the first one's route.
      const aiRun = await makeRun();
      const { agentEnv } = await brokerizeAgentEnvForRun(
        { GITHUB_TOKEN: REAL },
        { aiRunId: aiRun.id, agentModel: "claude-sonnet-5", hostEnv }
      );
      await ensureGithubBrokerBridge(agentEnv, { sandboxHome: home });
      const checkout = path.join(home, `repo-${round}`);
      await run("git", ["clone", "https://github.com/acme/repo.git", checkout], { env: bareEnv });
      assert.equal(fs.readFileSync(path.join(checkout, "README.md"), "utf8"), "hello\n");
      const route = fs.readFileSync(path.join(home, ".gitconfig-rdocs-github"), "utf8");
      assert.ok(route.includes(agentEnv.RDOCS_GITHUB_BROKER_URL));
      if (previousRoute) assert.ok(!route.includes(previousRoute));
      previousRoute = agentEnv.RDOCS_GITHUB_BROKER_URL;
      if (spawnSync("gh", ["--version"]).status === 0) {
        const who = await run("gh", ["api", "user", "--jq", ".login"], { env: bareEnv });
        assert.equal(who.stdout.trim(), "octo-test");
      } else if (round === 1) {
        t.diagnostic("gh is not installed here: only git was exercised");
      }
      await db.aiRun.update({ where: { id: aiRun.id }, data: { status: "SUCCEEDED" } });
    }
    for (const file of [".gitconfig", ".gitconfig-rdocs-github", ".config/gh/hosts.yml", ".config/gh/config.yml"]) {
      assert.ok(!fs.readFileSync(path.join(home, file), "utf8").includes(REAL), file);
    }
    assert.equal(fs.readFileSync(path.join(home, ".gitconfig"), "utf8").split("[include]").length, 2, "included once");
  } finally {
    github.server.close();
    front.server.close();
  }
});
