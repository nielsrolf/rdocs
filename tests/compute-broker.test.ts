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

import { brokeredComputeNote } from "../agent-core/agent-env";
import { db } from "../lib/db";
import { brokerizeAgentEnvForRun, isVirtualBrokerToken, planBrokerRewrites } from "../lib/credential-broker";
import { handleBrokerProxyRequest } from "../lib/credential-broker/proxy";
import {
  hubUrlViaBroker,
  huggingfaceAuthHeader,
  jwtExpiryMs,
  rewriteLfsBatchHrefs,
  runpodUpstream
} from "../lib/credential-broker/providers";
import { redactSecrets } from "../lib/secret-redaction";

// The real provider clients, driven from Python. Without an interpreter that
// has them (CI), the client tests are skipped and the protocol tests still run.
//   RDOCS_TEST_PYTHON=/path/to/venv/bin/python npm test
const PYTHON = process.env.RDOCS_TEST_PYTHON?.trim() || "python3";
function pythonHas(module: string): boolean {
  return spawnSync(PYTHON, ["-c", `import ${module}`], { stdio: "ignore" }).status === 0;
}

const run = promisify(execFile);
const REAL_HF = `hf_${"RealHubTokenForTheBrokerTest".padEnd(34, "x")}`;
const REAL_RUNPOD = `rpa_${"REALRUNPODKEYFORTHEBROKERTEST".padEnd(40, "X")}`;
const REAL_OW = `ow_${"realopenweightskeyforthebrokertest".padEnd(40, "x")}`;
const created = { users: [] as string[], documents: [] as string[] };
const tmpDirs: string[] = [];
const servers: http.Server[] = [];

function tmp(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function listen(server: http.Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function makeRun() {
  const user = await db.user.create({
    data: { email: `compute-${crypto.randomUUID()}@example.com`, name: "c", passwordHash: "x" }
  });
  created.users.push(user.id);
  const doc = await db.document.create({
    data: { title: "compute broker", content: JSON.stringify({ type: "doc", content: [] }), ownerId: user.id }
  });
  created.documents.push(doc.id);
  return db.aiRun.create({
    data: { documentId: doc.id, triggerType: "CONVERSATION", instruction: "t", status: "RUNNING" }
  });
}

test.after(async () => {
  for (const server of servers) server.close();
  await db.document.deleteMany({ where: { id: { in: created.documents } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
  await db.$disconnect();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** The broker route as the app serves it, on a real socket. */
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
      if (response.body && req.method !== "HEAD") Readable.fromWeb(response.body as never).pipe(res);
      else res.end();
    })().catch((error) => {
      res.writeHead(500).end(String(error));
    });
  });
  return { server, baseUrl: await listen(server) };
}

type Seen = { method: string; url: string; authorization?: string; contentType?: string; bytes?: number };

/**
 * A stand-in for the Hugging Face Hub and, on a second port, its CDN. The Hub
 * insists on the real token; the CDN fails the test if it is sent any.
 */
async function startFakeHub(projectRoot: string) {
  const seen: Seen[] = [];
  const cdnSeen: Seen[] = [];
  const commit = "c0ffee".padEnd(40, "0");
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  const small = Buffer.from('{"model_type":"tiny"}\n');
  const etag = (data: Buffer) => `"${crypto.createHash("sha256").update(data).digest("hex")}"`;

  const cdn = http.createServer((req, res) => {
    cdnSeen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
    if (req.headers.authorization) {
      res.writeHead(400).end("a signed URL must not be sent a token");
      return;
    }
    res.writeHead(200, { "content-length": String(big.length), etag: etag(big), "content-type": "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : big);
  });
  const cdnUrl = await listen(cdn);

  const basic = `Basic ${Buffer.from(`user:${REAL_HF}`).toString("base64")}`;
  const hub = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const self = `http://${req.headers.host}`;
      const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? Buffer.alloc(0) : await readBody(req);
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        bytes: body.length
      });
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
        res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
      const p = url.pathname;

      // git over smart HTTP: a Basic credential, like `git clone https://user:token@huggingface.co/…`.
      if (p.endsWith("/info/refs") || p.endsWith("/git-upload-pack") || p.endsWith("/git-receive-pack")) {
        if (req.headers.authorization !== basic) {
          res.writeHead(401, { "www-authenticate": 'Basic realm="Hub"' }).end("auth required");
          return;
        }
        const cgi = spawn("git", ["http-backend"], {
          env: {
            PATH: process.env.PATH,
            GIT_PROJECT_ROOT: projectRoot,
            GIT_HTTP_EXPORT_ALL: "1",
            REQUEST_METHOD: req.method,
            PATH_INFO: p,
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
            REMOTE_USER: "user",
            REMOTE_ADDR: "127.0.0.1"
          } as unknown as NodeJS.ProcessEnv
        });
        cgi.stdin.end(body);
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
        return;
      }

      if (req.headers.authorization !== `Bearer ${REAL_HF}`) {
        json(401, { error: "Invalid username or password." });
        return;
      }
      if (p === "/api/whoami-v2") return void json(200, { type: "user", name: "hub-test", auth: { type: "access_token" } });
      if (p === "/api/models/acme/tiny" || p === "/api/models/acme/tiny/revision/main") {
        return void json(200, { id: "acme/tiny", modelId: "acme/tiny", sha: commit, private: true, siblings: [] });
      }
      if (p === "/api/models/acme/tiny/preupload/main") {
        const files = (JSON.parse(body.toString()) as { files: { path: string }[] }).files;
        return void json(200, { files: files.map((f) => ({ path: f.path, uploadMode: "regular", shouldIgnore: false })) });
      }
      if (p === "/api/models/acme/tiny/commit/main") {
        return void json(200, { success: true, commitOid: commit, commitUrl: `${self}/acme/tiny/commit/${commit}`, hookOutput: "" });
      }
      if (p === "/acme/tiny.git/info/lfs/objects/batch") {
        return void json(200, {
          transfer: "basic",
          objects: [{
            oid: "ab".repeat(32),
            size: 5,
            actions: {
              upload: { href: `${cdnUrl}/upload?sig=1` },
              verify: { href: `${self}/acme/tiny.git/info/lfs/objects/verify`, header: {} }
            }
          }]
        });
      }
      const common = { "x-repo-commit": commit, "accept-ranges": "bytes" };
      // A small file, served by the Hub itself.
      if (p === "/acme/tiny/resolve/main/config.json" || p === `/acme/tiny/resolve/${commit}/config.json`) {
        res.writeHead(200, { ...common, etag: etag(small), "content-length": String(small.length), "content-type": "application/json" });
        res.end(req.method === "HEAD" ? undefined : small);
        return;
      }
      // A renamed repo: an absolute redirect that stays on the Hub.
      if (p === "/acme/old-name/resolve/main/config.json") {
        res.writeHead(307, { location: `${self}/acme/tiny/resolve/main/config.json` }).end();
        return;
      }
      // A large file: a relative redirect on the Hub, then a signed CDN URL.
      if (p === "/acme/tiny/resolve/main/model.bin" || p === `/acme/tiny/resolve/${commit}/model.bin`) {
        res.writeHead(307, { ...common, location: `/api/resolve-cache/models/acme/tiny/${commit}/model.bin` }).end();
        return;
      }
      if (p === `/api/resolve-cache/models/acme/tiny/${commit}/model.bin`) {
        res.writeHead(302, {
          ...common,
          location: `${cdnUrl}/blob/model.bin?sig=1`,
          "x-linked-etag": etag(big),
          "x-linked-size": String(big.length),
          link: `<${self}/api/models/acme/tiny/xet-read-token/${commit}>; rel="xet-auth"`
        }).end();
        return;
      }
      json(404, { error: `fake hub: no ${req.method} ${p}` });
    })();
  });
  return { baseUrl: await listen(hub), cdnUrl, seen, cdnSeen, big, small, commit };
}

// --- pure pieces ---------------------------------------------------------------

test("plans: HF, RunPod and OpenWeights leave the env; switches work one way only", () => {
  const env = {
    HF_TOKEN: REAL_HF,
    HUGGING_FACE_HUB_TOKEN: REAL_HF,
    RUNPOD_API_KEY: REAL_RUNPOD,
    OPENWEIGHTS_API_KEY: REAL_OW,
    TINKER_API_KEY: "tml-real-key"
  };
  const plans = planBrokerRewrites(env, "claude-sonnet-5", { hostEnv: {} });
  const by = (provider: string) => plans.find((plan) => plan.provider === provider);

  const hf = by("huggingface")!;
  assert.equal(hf.envKey, "HF_TOKEN");
  assert.deepEqual(hf.aliasEnvKeys, ["HUGGING_FACE_HUB_TOKEN"]);
  assert.equal(hf.tokenPrefix, "hf_");
  assert.deepEqual(hf.extraEnv("http://b/api/broker/k"), { HF_ENDPOINT: "http://b/api/broker/k" });
  assert.deepEqual(hf.gitConfig!("http://b/api/broker/k", "hf_rdocs-vk-abc"), [
    ["url.http://b/api/broker/k/.insteadOf", "https://huggingface.co/"],
    ["url.http://b/api/broker/k/.insteadOf", "https://hf.co/"],
    ["http.http://b/api/broker/k/.extraheader", "Authorization: Bearer hf_rdocs-vk-abc"]
  ]);

  assert.deepEqual(by("runpod")!.extraEnv("http://b/api/broker/k"), {
    RUNPOD_API_BASE_URL: "http://b/api/broker/k/api",
    RUNPOD_ENDPOINT_BASE_URL: "http://b/api/broker/k/serverless",
    RUNPOD_REST_BASE_URL: "http://b/api/broker/k/rest"
  });

  const ow = by("openweights")!;
  assert.equal(ow.tokenPrefix, "ow_");
  assert.equal(ow.upstreamBaseUrl, "https://cmaguqyuzweixkrqjvnf.supabase.co");
  assert.deepEqual(ow.extraEnv("http://b/api/broker/k"), { SUPABASE_URL: "http://b/api/broker/k" });
  // A workspace on another OpenWeights deployment keeps its upstream.
  assert.equal(
    planBrokerRewrites({ ...env, SUPABASE_URL: "https://dev.supabase.co" }, null, { hostEnv: {} })
      .find((plan) => plan.provider === "openweights")!.upstreamBaseUrl,
    "https://dev.supabase.co"
  );
  // A raw JWT is the user's own dynamic auth.
  assert.equal(
    planBrokerRewrites({ OPENWEIGHTS_API_KEY: "eyJ.a.jwt" }, null, { hostEnv: {} }).some((p) => p.provider === "openweights"),
    false
  );
  assert.ok(by("tinker"), "Tinker is brokered by default now");

  // The deployment can switch a provider off …
  const off = planBrokerRewrites(env, null, {
    hostEnv: { AGENT_BROKER_HUGGINGFACE: "0", AGENT_BROKER_RUNPOD: "off", AGENT_BROKER_OPENWEIGHTS: "false", AGENT_BROKER_TINKER: "0" }
  }).map((plan) => plan.provider);
  assert.deepEqual(off, []);
  // … a workspace can switch it back on for itself, but never off.
  const backOn = planBrokerRewrites({ ...env, RDOCS_BROKER_TINKER: "1" }, null, { hostEnv: { AGENT_BROKER_TINKER: "0" } });
  assert.ok(backOn.some((plan) => plan.provider === "tinker"));
  const workspaceOff = planBrokerRewrites({ ...env, RDOCS_BROKER_HUGGINGFACE: "0" }, null, { hostEnv: {} });
  assert.ok(workspaceOff.some((plan) => plan.provider === "huggingface"));

  // An already virtual token (a retried run) is not brokered twice.
  assert.deepEqual(
    planBrokerRewrites({ HF_TOKEN: "hf_rdocs-vk-abc", RUNPOD_API_KEY: "rdocs-vk-abc", OPENWEIGHTS_API_KEY: "ow_rdocs-vk-abc" }, null, { hostEnv: {} }),
    []
  );
  assert.ok(isVirtualBrokerToken("hf_rdocs-vk-abc") && isVirtualBrokerToken("ow_rdocs-vk-abc"));
  assert.ok(!isVirtualBrokerToken(REAL_HF) && !isVirtualBrokerToken(REAL_OW));
});

test("routing helpers", () => {
  assert.equal(runpodUpstream("https://api.runpod.io", "api"), "https://api.runpod.io");
  assert.equal(runpodUpstream("https://api.runpod.io", "serverless"), "https://api.runpod.ai/v2");
  assert.equal(runpodUpstream("https://api.runpod.io", "rest"), "https://rest.runpod.io/v1");
  assert.equal(runpodUpstream("http://fake:1", "serverless"), "http://fake:1/serverless");
  assert.equal(runpodUpstream("https://api.runpod.io", "console"), null);

  assert.equal(huggingfaceAuthHeader(["api", "whoami-v2"], "T"), "Bearer T");
  assert.equal(huggingfaceAuthHeader(["acme", "tiny.git", "info", "lfs", "objects", "batch"], "T"), "Bearer T");
  const basic = `Basic ${Buffer.from("user:T").toString("base64")}`;
  assert.equal(huggingfaceAuthHeader(["acme", "tiny", "info", "refs"], "T"), basic);
  assert.equal(huggingfaceAuthHeader(["acme", "tiny", "git-receive-pack"], "T"), basic);

  const hub = "https://huggingface.co";
  assert.equal(hubUrlViaBroker("/api/resolve-cache/x", hub, "/api/broker/k"), "/api/broker/k/api/resolve-cache/x");
  assert.equal(hubUrlViaBroker(`${hub}/acme/tiny/resolve/main/a`, hub, "/api/broker/k"), "/api/broker/k/acme/tiny/resolve/main/a");
  assert.equal(hubUrlViaBroker("https://cdn-lfs.hf.co/blob?sig=1", hub, "/api/broker/k"), "https://cdn-lfs.hf.co/blob?sig=1");
  assert.equal(hubUrlViaBroker("https://huggingface.co.evil.example/x", hub, "/api/broker/k"), "https://huggingface.co.evil.example/x");

  const batch = JSON.parse(
    rewriteLfsBatchHrefs(
      JSON.stringify({ objects: [{ actions: { upload: { href: "https://s3.example/put?sig" }, verify: { href: `${hub}/a/b.git/info/lfs/objects/verify` } } }] }),
      hub,
      "http://b/api/broker/k"
    )
  );
  assert.equal(batch.objects[0].actions.upload.href, "https://s3.example/put?sig");
  assert.equal(batch.objects[0].actions.verify.href, "http://b/api/broker/k/a/b.git/info/lfs/objects/verify");

  const exp = Math.floor(Date.now() / 1000) + 600;
  const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
  assert.equal(jwtExpiryMs(jwt), exp * 1000);
  assert.equal(jwtExpiryMs("not-a-jwt"), null);
});

test("the agent is told what a stand-in credential cannot do", () => {
  assert.equal(brokeredComputeNote({ HF_TOKEN: REAL_HF }), "");
  const note = brokeredComputeNote({ HF_TOKEN: "hf_rdocs-vk-abc", RUNPOD_API_KEY: "rdocs-vk-abc" });
  assert.match(note, /HF_ENDPOINT/);
  assert.match(note, /RUNPOD_API_BASE_URL/);
  assert.match(note, /never hand one to another machine/);
  assert.doesNotMatch(note, /OPENWEIGHTS/);
});

test("stored output masks OpenWeights and Modal credentials by shape", () => {
  const modalId = `ak-${"A1b2C3d4E5f6G7h8I9j0K1"}`;
  const modalSecret = `as-${"Z9y8X7w6V5u4T3s2R1q0P9"}`;
  const text = `OPENWEIGHTS_API_KEY=${REAL_OW}\nMODAL_TOKEN_ID=${modalId}\nMODAL_TOKEN_SECRET=${modalSecret}\nrow_count=12 has-a-dash tasks-done`;
  const masked = redactSecrets(text);
  assert.ok(!masked.includes(REAL_OW) && !masked.includes(modalId) && !masked.includes(modalSecret));
  assert.equal(masked.length, text.length);
  assert.ok(masked.includes("row_count=12 has-a-dash tasks-done"));
  // The stand-ins are not secrets and stay readable.
  assert.equal(redactSecrets("ow_rdocs-vk-0123456789abcdef0123456789abcdef"), "ow_rdocs-vk-0123456789abcdef0123456789abcdef");
});

// --- Hugging Face ----------------------------------------------------------------

async function brokeredHub(extraHostEnv: Record<string, string> = {}) {
  const projectRoot = tmp("hub-repos-");
  const hub = await startFakeHub(projectRoot);
  const front = await startBrokerFront({});
  const aiRun = await makeRun();
  const hostEnv = {
    AGENT_CREDENTIAL_BROKER: "1",
    AGENT_BROKER_BASE_URL: front.baseUrl,
    RDOCS_HUGGINGFACE_UPSTREAM: hub.baseUrl,
    ...extraHostEnv
  };
  const { agentEnv, minted } = await brokerizeAgentEnvForRun(
    { HF_TOKEN: REAL_HF, HUGGING_FACE_HUB_TOKEN: REAL_HF },
    { aiRunId: aiRun.id, agentModel: "claude-sonnet-5", hostEnv }
  );
  assert.deepEqual(minted, ["huggingface"]);
  assert.match(agentEnv.HF_TOKEN, /^hf_rdocs-vk-[0-9a-f]{48}$/);
  assert.equal(agentEnv.HUGGING_FACE_HUB_TOKEN, agentEnv.HF_TOKEN);
  assert.ok(!JSON.stringify(agentEnv).includes(REAL_HF), "no part of the run env holds the real token");
  return { hub, front, aiRun, agentEnv, projectRoot };
}

test("Hugging Face: redirects, sizes, Xet links and LFS answers lead back to the broker", async () => {
  const { hub, front, aiRun, agentEnv } = await brokeredHub();
  const headers = { authorization: `Bearer ${agentEnv.HF_TOKEN}` };
  const base = agentEnv.HF_ENDPOINT;
  const keyPath = new URL(base).pathname;

  // A small file: the size survives (huggingface_hub refuses a file without one).
  const head = await fetch(`${base}/acme/tiny/resolve/main/config.json`, { method: "HEAD", headers: { ...headers, "accept-encoding": "identity" } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(hub.small.length));
  assert.equal(head.headers.get("x-repo-commit"), hub.commit);

  // A relative redirect keeps the key prefix; an absolute one to the Hub comes back here.
  const first = await fetch(`${base}/acme/tiny/resolve/main/model.bin`, { method: "HEAD", headers, redirect: "manual" });
  assert.equal(first.status, 307);
  assert.equal(first.headers.get("location"), `${keyPath}/api/resolve-cache/models/acme/tiny/${hub.commit}/model.bin`);
  const renamed = await fetch(`${base}/acme/old-name/resolve/main/config.json`, { method: "HEAD", headers, redirect: "manual" });
  assert.equal(renamed.headers.get("location"), `${keyPath}/acme/tiny/resolve/main/config.json`);

  // The CDN URL is passed on as it is; the Xet token route is ours.
  const second = await fetch(`${front.baseUrl}${first.headers.get("location")}`, { method: "HEAD", headers, redirect: "manual" });
  assert.equal(second.status, 302);
  assert.equal(second.headers.get("location"), `${hub.cdnUrl}/blob/model.bin?sig=1`);
  assert.equal(second.headers.get("x-linked-size"), String(hub.big.length));
  assert.equal(second.headers.get("link"), `<${base}/api/models/acme/tiny/xet-read-token/${hub.commit}>; rel="xet-auth"`);

  // git-lfs: the verify step goes through the broker, the upload to storage directly.
  const batch = await fetch(`${base}/acme/tiny.git/info/lfs/objects/batch`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/vnd.git-lfs+json" },
    body: JSON.stringify({ operation: "upload", objects: [{ oid: "ab".repeat(32), size: 5 }] })
  });
  const actions = ((await batch.json()) as { objects: { actions: Record<string, { href: string }> }[] }).objects[0].actions;
  assert.equal(actions.verify.href, `${base}/acme/tiny.git/info/lfs/objects/verify`);
  assert.equal(actions.upload.href, `${hub.cdnUrl}/upload?sig=1`);

  // Wrong token, and a finished run.
  const wrong = await fetch(`${base}/api/whoami-v2`, { headers: { authorization: `Bearer ${REAL_HF}` } });
  assert.equal(wrong.status, 401);
  assert.ok(hub.seen.every((entry) => entry.authorization?.includes(REAL_HF) || entry.authorization?.startsWith("Basic ")));
  await db.aiRun.update({ where: { id: aiRun.id }, data: { status: "COMPLETED" } });
  const after = await fetch(`${base}/api/whoami-v2`, { headers });
  assert.equal(after.status, 401);
});

test("Hugging Face: huggingface_hub downloads and uploads with a stand-in token", { skip: !pythonHas("huggingface_hub") }, async () => {
  const { hub, agentEnv } = await brokeredHub();
  const home = tmp("hf-home-");
  const env = { PATH: process.env.PATH ?? "", HOME: home, HF_HOME: path.join(home, "hf"), HF_HUB_DISABLE_TELEMETRY: "1", ...agentEnv } as unknown as NodeJS.ProcessEnv;
  const script = `
import json, os, sys
from huggingface_hub import HfApi, hf_hub_download
api = HfApi()
out = {"whoami": api.whoami()["name"]}
small = hf_hub_download("acme/tiny", "config.json")
out["small"] = open(small).read()
big = hf_hub_download("acme/tiny", "model.bin")
out["big_size"] = os.path.getsize(big)
commit = api.upload_file(path_or_fileobj=b"x" * 200000, path_in_repo="results/out.bin", repo_id="acme/tiny")
out["commit"] = str(commit.oid)
print(json.dumps(out))
`;
  const result = await run(PYTHON, ["-c", script], { env, maxBuffer: 16 << 20 }).catch((error: { stdout: string; stderr: string }) => {
    throw new Error(`huggingface_hub failed:\n${error.stderr}\nfake hub saw:\n${hub.seen.map((s) => `${s.method} ${s.url}`).join("\n")}`);
  });
  const out = JSON.parse(result.stdout.trim().split("\n").pop()!) as Record<string, unknown>;
  assert.equal(out.whoami, "hub-test");
  assert.equal(out.small, hub.small.toString());
  assert.equal(out.big_size, hub.big.length);
  assert.equal(out.commit, hub.commit);

  // The file's bytes came from the CDN directly, without any token.
  assert.ok(hub.cdnSeen.some((entry) => entry.method === "GET"));
  assert.ok(hub.cdnSeen.every((entry) => !entry.authorization));
  // The commit (file content inline) reached the Hub with the real token.
  const commit = hub.seen.find((entry) => entry.url.startsWith("/api/models/acme/tiny/commit/main"));
  assert.ok(commit && commit.bytes! > 200000 && commit.authorization === `Bearer ${REAL_HF}`);
  // Nothing the sandbox printed or wrote holds the real token.
  assert.ok(!`${result.stdout}${result.stderr}`.includes(REAL_HF));
  const written = spawnSync("grep", ["-rl", REAL_HF, home], { encoding: "utf8" });
  assert.equal(written.stdout.trim(), "");
});

test("Hugging Face: git clone and push of a Hub repo", async () => {
  const { hub, agentEnv, projectRoot } = await brokeredHub();
  const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
  const bare = path.join(projectRoot, "acme", "tiny");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  await run("git", ["init", "--bare", "-b", "main", bare]);
  await run("git", ["-C", bare, "config", "http.receivepack", "true"]);
  const seedDir = tmp("hub-seed-");
  await run("git", ["clone", bare, seedDir]);
  fs.writeFileSync(path.join(seedDir, "README.md"), "model card\n");
  await run("git", ["-C", seedDir, "add", "."]);
  await run("git", ["-C", seedDir, ...identity, "commit", "-m", "seed"]);
  await run("git", ["-C", seedDir, "push", "origin", "HEAD:main"]);

  const home = tmp("hub-git-home-");
  const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_TERMINAL_PROMPT: "0", ...agentEnv } as unknown as NodeJS.ProcessEnv;
  const checkout = path.join(home, "tiny");
  await run("git", ["clone", "https://huggingface.co/acme/tiny", checkout], { env });
  assert.equal(fs.readFileSync(path.join(checkout, "README.md"), "utf8"), "model card\n");
  fs.writeFileSync(path.join(checkout, "eval.json"), "{}\n");
  await run("git", ["-C", checkout, "add", "."], { env });
  await run("git", ["-C", checkout, ...identity, "commit", "-m", "agent results"], { env });
  const push = await run("git", ["-C", checkout, "push", "origin", "HEAD:main"], { env });
  const log = await run("git", ["-C", bare, "log", "--format=%s", "main"]);
  assert.deepEqual(log.stdout.trim().split("\n"), ["agent results", "seed"]);

  const remotes = await run("git", ["-C", checkout, "remote", "-v"], { env });
  // git shows the address it really uses (the broker key's URL, no secret in it); the checkout keeps the Hub's.
  const printed = `${push.stdout}${push.stderr}${remotes.stdout}`;
  assert.ok(!printed.includes(REAL_HF) && !printed.includes("rdocs-vk-"));
  const config = fs.readFileSync(path.join(checkout, ".git", "config"), "utf8");
  assert.match(config, /url = https:\/\/huggingface\.co\/acme\/tiny/);
  assert.ok(!config.includes("rdocs-vk-") && !config.includes("/api/broker/"));
  assert.ok(hub.seen.some((entry) => entry.url.includes("git-receive-pack")));
});

test("Hugging Face is served after the workspace budget is used up; RunPod is not", async () => {
  const { agentEnv } = await brokeredHub();
  const keyId = agentEnv.HF_ENDPOINT.split("/").pop()!;
  const exhausted = async () => ({ costsProject: "p", exhausted: true });
  const hf = await handleBrokerProxyRequest(
    new Request(`http://broker/api/broker/${keyId}/api/whoami-v2`, { headers: { authorization: `Bearer ${agentEnv.HF_TOKEN}` } }),
    keyId,
    ["api", "whoami-v2"],
    { env: {}, runBudget: exhausted }
  );
  assert.equal(hf.status, 200);

  const aiRun = await makeRun();
  const runpod = await brokerizeAgentEnvForRun(
    { RUNPOD_API_KEY: REAL_RUNPOD },
    { aiRunId: aiRun.id, agentModel: null, hostEnv: { AGENT_CREDENTIAL_BROKER: "1", AGENT_BROKER_BASE_URL: "http://broker" } }
  );
  const runpodKey = runpod.agentEnv.RUNPOD_API_BASE_URL.split("/").slice(-2)[0];
  const refused = await handleBrokerProxyRequest(
    new Request(`http://broker/api/broker/${runpodKey}/api/graphql`, {
      method: "POST",
      headers: { authorization: `Bearer ${runpod.agentEnv.RUNPOD_API_KEY}`, "content-type": "application/json" },
      body: "{}"
    }),
    runpodKey,
    ["api", "graphql"],
    { env: {}, runBudget: exhausted }
  );
  assert.equal(refused.status, 402);
});

// --- RunPod ----------------------------------------------------------------------

async function startFakeRunpod() {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      await readBody(req);
      seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
      const json = (status: number, value: unknown) =>
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      const authorized = req.headers.authorization === `Bearer ${REAL_RUNPOD}` || url.searchParams.get("api_key") === REAL_RUNPOD;
      if (!authorized) return void json(401, { errors: [{ message: "Unauthorized" }] });
      if (url.pathname === "/api/graphql") {
        return void json(200, { data: { myself: { id: "user-1", pubKey: "", networkVolumes: [], pods: [{ id: "pod-1", name: "p" }] } } });
      }
      // runpod 2.x lists pods over REST on the same host; 1.x asks GraphQL.
      if (url.pathname === "/api/v2/pods") return void json(200, { pods: [{ id: "pod-1", name: "p" }] });
      if (url.pathname === "/serverless/ep-1/health") return void json(200, { jobs: { completed: 3 }, workers: { idle: 1 } });
      if (url.pathname === "/rest/pods") return void json(200, [{ id: "pod-1" }]);
      json(404, { error: `fake runpod: no ${req.method} ${url.pathname}` });
    })();
  });
  return { baseUrl: await listen(server), seen };
}

async function brokeredRunpod() {
  const runpod = await startFakeRunpod();
  const front = await startBrokerFront({});
  const aiRun = await makeRun();
  const { agentEnv, minted } = await brokerizeAgentEnvForRun(
    { RUNPOD_API_KEY: REAL_RUNPOD },
    {
      aiRunId: aiRun.id,
      agentModel: null,
      hostEnv: { AGENT_CREDENTIAL_BROKER: "1", AGENT_BROKER_BASE_URL: front.baseUrl, RDOCS_RUNPOD_UPSTREAM: runpod.baseUrl }
    }
  );
  assert.deepEqual(minted, ["runpod"]);
  assert.ok(!JSON.stringify(agentEnv).includes(REAL_RUNPOD));
  return { runpod, agentEnv };
}

test("RunPod: header and ?api_key= callers both leave with the real key", async () => {
  const { runpod, agentEnv } = await brokeredRunpod();
  const byHeader = await fetch(`${agentEnv.RUNPOD_REST_BASE_URL}/pods`, { headers: { authorization: `Bearer ${agentEnv.RUNPOD_API_KEY}` } });
  assert.deepEqual(await byHeader.json(), [{ id: "pod-1" }]);
  const byQuery = await fetch(`${agentEnv.RUNPOD_API_BASE_URL}/graphql?api_key=${agentEnv.RUNPOD_API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "query { myself { id } }" })
  });
  assert.equal(byQuery.status, 200);
  assert.equal(runpod.seen.at(-1)!.url, `/api/graphql?api_key=${REAL_RUNPOD}`);
  const unknown = await fetch(`${agentEnv.RUNPOD_API_BASE_URL.replace(/\/api$/, "")}/console/x`, {
    headers: { authorization: `Bearer ${agentEnv.RUNPOD_API_KEY}` }
  });
  assert.equal(unknown.status, 404);
  const wrong = await fetch(`${agentEnv.RUNPOD_REST_BASE_URL}/pods`, { headers: { authorization: `Bearer ${REAL_RUNPOD}` } });
  assert.equal(wrong.status, 401);
});

test("RunPod: the runpod SDK lists pods and checks an endpoint with a stand-in key", { skip: !pythonHas("runpod") }, async () => {
  const { runpod, agentEnv } = await brokeredRunpod();
  const home = tmp("runpod-home-");
  const env = { PATH: process.env.PATH ?? "", HOME: home, ...agentEnv } as unknown as NodeJS.ProcessEnv;
  const script = `
import json, os, runpod
runpod.api_key = os.environ["RUNPOD_API_KEY"]
pods = runpod.get_pods()
health = runpod.Endpoint("ep-1").health()
print(json.dumps({"pods": [p["id"] for p in pods], "health": health}))
`;
  const result = await run(PYTHON, ["-c", script], { env }).catch((error: { stderr: string }) => {
    throw new Error(`runpod SDK failed:\n${error.stderr}\nfake saw:\n${runpod.seen.map((s) => `${s.method} ${s.url}`).join("\n")}`);
  });
  const out = JSON.parse(result.stdout.trim().split("\n").pop()!) as { pods: string[]; health: { workers: { idle: number } } };
  assert.deepEqual(out.pods, ["pod-1"]);
  assert.equal(out.health.workers.idle, 1);
  assert.ok(runpod.seen.length >= 2 && runpod.seen.every((entry) => entry.authorization === `Bearer ${REAL_RUNPOD}`));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(REAL_RUNPOD));
});

// --- OpenWeights -------------------------------------------------------------------

async function startFakeSupabase() {
  const seen: Seen[] = [];
  const state = { exchanges: 0, jwt: "", revoked: new Set<string>() };
  const newJwt = () => {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, n: state.exchanges })).toString("base64url");
    return `eyJhbGciOiJIUzI1NiJ9.${payload}.${crypto.randomBytes(16).toString("base64url")}`;
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const body = await readBody(req);
      seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, bytes: body.length });
      const json = (status: number, value: unknown) =>
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (!req.headers.apikey) return void json(401, { message: "No API key found in request" });
      if (url.pathname === "/rest/v1/rpc/exchange_api_token_for_jwt") {
        const token = (JSON.parse(body.toString()) as { api_token?: string }).api_token;
        if (token !== REAL_OW) return void json(400, { code: "P0001", message: "Invalid API token" });
        state.exchanges += 1;
        state.jwt = newJwt();
        return void json(200, state.jwt);
      }
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (bearer !== state.jwt || state.revoked.has(bearer)) return void json(401, { message: "JWT expired" });
      if (url.pathname === "/rest/v1/rpc/get_organization_from_token") return void json(200, "org-1");
      if (url.pathname === "/rest/v1/organizations") return void json(200, { id: "org-1", name: "Test Org" });
      if (url.pathname === "/rest/v1/organization_secrets") return void json(200, []);
      json(404, { message: `fake supabase: no ${req.method} ${url.pathname}` });
    })();
  });
  return { baseUrl: await listen(server), seen, state };
}

async function brokeredOpenweights() {
  const supabase = await startFakeSupabase();
  const front = await startBrokerFront({});
  const aiRun = await makeRun();
  const { agentEnv, minted } = await brokerizeAgentEnvForRun(
    { OPENWEIGHTS_API_KEY: REAL_OW, SUPABASE_URL: supabase.baseUrl },
    { aiRunId: aiRun.id, agentModel: null, hostEnv: { AGENT_CREDENTIAL_BROKER: "1", AGENT_BROKER_BASE_URL: front.baseUrl } }
  );
  assert.deepEqual(minted, ["openweights"]);
  assert.match(agentEnv.OPENWEIGHTS_API_KEY, /^ow_rdocs-vk-[0-9a-f]{48}$/);
  assert.ok(agentEnv.SUPABASE_URL.startsWith(front.baseUrl));
  assert.ok(!JSON.stringify(agentEnv).includes(REAL_OW));
  return { supabase, agentEnv, aiRun };
}

test("OpenWeights: the key-for-JWT swap is answered by the broker and the JWT never comes back", async () => {
  const { supabase, agentEnv, aiRun } = await brokeredOpenweights();
  const anon = "anon-public-key";
  const base = agentEnv.SUPABASE_URL;
  const exchange = (token: string) =>
    fetch(`${base}/rest/v1/rpc/exchange_api_token_for_jwt`, {
      method: "POST",
      headers: { apikey: anon, authorization: `Bearer ${anon}`, "content-type": "application/json" },
      body: JSON.stringify({ api_token: token })
    });

  const swapped = await exchange(agentEnv.OPENWEIGHTS_API_KEY);
  assert.equal(swapped.status, 200);
  const standIn = (await swapped.json()) as string;
  assert.equal(standIn, agentEnv.OPENWEIGHTS_API_KEY, "the sandbox gets its own stand-in back, not a JWT");
  assert.equal(supabase.state.exchanges, 1);

  const call = () =>
    fetch(`${base}/rest/v1/rpc/get_organization_from_token`, {
      method: "POST",
      headers: { apikey: anon, authorization: `Bearer ${standIn}`, "content-type": "application/json" },
      body: "{}"
    });
  const first = await call();
  assert.equal(await first.json(), "org-1");
  assert.equal(supabase.seen.at(-1)!.authorization, `Bearer ${supabase.state.jwt}`);
  await call();
  assert.equal(supabase.state.exchanges, 1, "the JWT is reused while it is good");

  // The provider drops the JWT: the 401 reaches the SDK, whose retry swaps again.
  supabase.state.revoked.add(supabase.state.jwt);
  assert.equal((await call()).status, 401);
  assert.equal((await exchange(agentEnv.OPENWEIGHTS_API_KEY)).status, 200);
  assert.equal(supabase.state.exchanges, 2);
  assert.equal(await (await call()).json(), "org-1");

  // The real key is no use at the broker, and a request without a token is refused.
  assert.equal((await exchange(REAL_OW)).status, 401);
  const anonymous = await fetch(`${base}/rest/v1/organizations`, { headers: { apikey: anon, authorization: `Bearer ${anon}` } });
  assert.equal(anonymous.status, 401);

  await db.aiRun.update({ where: { id: aiRun.id }, data: { status: "COMPLETED" } });
  assert.equal((await call()).status, 401);
});

test("OpenWeights: a rejected key reports the provider's own message", async () => {
  const supabase = await startFakeSupabase();
  const front = await startBrokerFront({});
  const aiRun = await makeRun();
  const { agentEnv } = await brokerizeAgentEnvForRun(
    { OPENWEIGHTS_API_KEY: `ow_${"revokedkey".padEnd(40, "y")}`, SUPABASE_URL: supabase.baseUrl },
    { aiRunId: aiRun.id, agentModel: null, hostEnv: { AGENT_CREDENTIAL_BROKER: "1", AGENT_BROKER_BASE_URL: front.baseUrl } }
  );
  const response = await fetch(`${agentEnv.SUPABASE_URL}/rest/v1/rpc/exchange_api_token_for_jwt`, {
    method: "POST",
    headers: { apikey: "anon", authorization: "Bearer anon", "content-type": "application/json" },
    body: JSON.stringify({ api_token: agentEnv.OPENWEIGHTS_API_KEY })
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Invalid API token/);
});

test("OpenWeights: the openweights SDK starts with a stand-in key", { skip: !pythonHas("openweights") }, async () => {
  const { supabase, agentEnv } = await brokeredOpenweights();
  const home = tmp("ow-home-");
  const env = { PATH: process.env.PATH ?? "", HOME: home, ...agentEnv } as unknown as NodeJS.ProcessEnv;
  const script = `
import json
from openweights import OpenWeights
ow = OpenWeights()
print(json.dumps({"org": ow.org_name, "org_id": ow.organization_id, "auth": ow._supabase.options.headers.get("Authorization")}))
`;
  const result = await run(PYTHON, ["-c", script], { env, maxBuffer: 16 << 20 }).catch((error: { stderr: string }) => {
    throw new Error(`openweights SDK failed:\n${error.stderr}\nfake saw:\n${supabase.seen.map((s) => `${s.method} ${s.url}`).join("\n")}`);
  });
  const out = JSON.parse(result.stdout.trim().split("\n").pop()!) as { org: string; org_id: string; auth: string };
  assert.equal(out.org, "Test Org");
  assert.equal(out.org_id, "org-1");
  assert.equal(out.auth, `Bearer ${agentEnv.OPENWEIGHTS_API_KEY}`, "what the SDK holds as its JWT is the stand-in");
  const printed = `${result.stdout}${result.stderr}`;
  assert.ok(!printed.includes(REAL_OW) && !printed.includes(supabase.state.jwt));
});

// --- sandbox HOME ----------------------------------------------------------------

test("sandbox HOME: the stand-in Hugging Face token and git route follow the run, and go when the run has none", async () => {
  const { syncSandboxComputeBroker } = await import("../agent-core/compute-broker-sandbox");
  const home = tmp("compute-home-");
  const tokenFile = path.join(home, ".cache", "huggingface", "token");
  const env = {
    HF_TOKEN: "hf_rdocs-vk-0123",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "url.http://b/api/broker/k/.insteadOf",
    GIT_CONFIG_VALUE_0: "https://huggingface.co/",
    GIT_CONFIG_KEY_1: "http.http://b/api/broker/k/.extraheader",
    GIT_CONFIG_VALUE_1: "Authorization: Bearer hf_rdocs-vk-0123"
  };
  syncSandboxComputeBroker(home, env);
  assert.equal(fs.readFileSync(tokenFile, "utf8"), "hf_rdocs-vk-0123");
  const rewritten = await run("git", ["ls-remote", "--get-url", "https://huggingface.co/acme/tiny"], {
    env: { PATH: process.env.PATH ?? "", HOME: home } as unknown as NodeJS.ProcessEnv
  });
  assert.equal(rewritten.stdout.trim(), "http://b/api/broker/k/acme/tiny");

  // The next run has no Hugging Face credential: nothing of the old one stays in force.
  syncSandboxComputeBroker(home, {});
  assert.equal(fs.existsSync(tokenFile), false);
  const plain = await run("git", ["ls-remote", "--get-url", "https://huggingface.co/acme/tiny"], {
    env: { PATH: process.env.PATH ?? "", HOME: home } as unknown as NodeJS.ProcessEnv
  });
  assert.equal(plain.stdout.trim(), "https://huggingface.co/acme/tiny");

  // A real login the user's own code stored is not ours to remove.
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, REAL_HF);
  syncSandboxComputeBroker(home, {});
  assert.equal(fs.readFileSync(tokenFile, "utf8"), REAL_HF);
});
