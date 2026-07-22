import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

// Same-process key: broker rows created below are decrypted with this key.
process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

import { db } from "../lib/db";
import {
  brokerizeAgentEnvForRun,
  hashBrokerToken,
  normalizeUpstreamForHost,
  planBrokerRewrites,
  resolveBrokerRequest,
  revokeBrokerKeysForRun
} from "../lib/credential-broker";
import { handleBrokerProxyRequest } from "../lib/credential-broker/proxy";
import { markAiRunSucceeded } from "../lib/ai-runs";
import {
  effectiveIsSecret,
  isSecretEnvKey,
  listDocumentEnvMasked,
  setDocumentEnvSecretFlag,
  upsertDocumentEnv
} from "../lib/document-env";
import { encryptSecret } from "../lib/secret-crypto";

const BROKER_ON = { AGENT_CREDENTIAL_BROKER: "1", AGENT_RUNNER_MODE: "container" };

const created = { users: [] as string[], documents: [] as string[] };

async function makeRun() {
  const user = await db.user.create({
    data: { email: `broker-${crypto.randomUUID()}@example.com`, name: "broker", passwordHash: "x" }
  });
  created.users.push(user.id);
  const doc = await db.document.create({
    data: {
      title: "broker test",
      content: JSON.stringify({ type: "doc", content: [] }),
      ownerId: user.id
    }
  });
  created.documents.push(doc.id);
  const run = await db.aiRun.create({
    data: { documentId: doc.id, triggerType: "CONVERSATION", instruction: "t", status: "RUNNING" }
  });
  return run;
}

test.after(async () => {
  await db.document.deleteMany({ where: { id: { in: created.documents } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
  await db.$disconnect();
});

// --- planBrokerRewrites -----------------------------------------------------

test("plans an x-api-key rewrite for an Anthropic API key run", () => {
  const plans = planBrokerRewrites({ ANTHROPIC_API_KEY: "sk-ant-real" }, "claude-sonnet-5", {
    hostEnv: {}
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].envKey, "ANTHROPIC_API_KEY");
  assert.equal(plans[0].authMode, "x-api-key");
  assert.equal(plans[0].secretValue, "sk-ant-real");
  assert.deepEqual(plans[0].extraEnv("http://b/api/broker/k1"), {
    ANTHROPIC_BASE_URL: "http://b/api/broker/k1"
  });
});

test("plans a bearer rewrite for an OAuth token, and host-oauth via secretRef", () => {
  const oauth = planBrokerRewrites({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x" }, "claude-sonnet-5", {
    hostEnv: {}
  });
  assert.equal(oauth[0].authMode, "authorization-bearer");
  assert.equal(oauth[0].secretValue, "sk-ant-oat-x");

  const hostFallback = planBrokerRewrites({}, "claude-sonnet-5", {
    hostEnv: {},
    hostOAuthAvailable: true
  });
  assert.equal(hostFallback.length, 1);
  assert.equal(hostFallback[0].envKey, "CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(hostFallback[0].secretRef, "host-claude-oauth");
  assert.equal(hostFallback[0].secretValue, undefined);
});

test("brokers the active provider key (openrouter/litellm) plus OPENAI_API_KEY", () => {
  const plans = planBrokerRewrites(
    { OPENROUTER_API_KEY: "sk-or-real", OPENAI_API_KEY: "sk-openai" },
    "openrouter/openai/gpt-5.2",
    { hostEnv: {} }
  );
  const providers = plans.map((p) => p.provider).sort();
  assert.deepEqual(providers, ["openai", "openrouter"]);
  const or = plans.find((p) => p.provider === "openrouter")!;
  assert.deepEqual(or.extraEnv("http://b/api/broker/k"), {
    OPENROUTER_BASE_URL: "http://b/api/broker/k"
  });

  const litellm = planBrokerRewrites({ LITELLM_API_KEY: "llk" }, "litellm/qwen", {
    hostEnv: { LITELLM_BASE_URL: "http://host.docker.internal:9274" }
  });
  assert.equal(litellm.length, 1);
  assert.equal(litellm[0].upstreamBaseUrl, "http://host.docker.internal:9274");
  assert.deepEqual(litellm[0].extraEnv("http://b/api/broker/k"), {
    LITELLM_BASE_URL: "http://b/api/broker/k"
  });
});

test("local-model runs and empty envs produce no rewrites", () => {
  assert.deepEqual(planBrokerRewrites({}, "claude-sonnet-5", { hostEnv: {} }), []);
  assert.deepEqual(
    planBrokerRewrites({ LOCAL_MODEL_BASE_URL: "http://x" }, "local/qwen", { hostEnv: {} }),
    []
  );
});

test("normalizeUpstreamForHost rewrites docker's magic hostname to loopback", () => {
  assert.equal(
    normalizeUpstreamForHost("http://host.docker.internal:9274/"),
    "http://127.0.0.1:9274"
  );
  assert.equal(normalizeUpstreamForHost("https://api.anthropic.com"), "https://api.anthropic.com");
});

// --- brokerizeAgentEnvForRun + resolveBrokerRequest -------------------------

test("brokerize replaces the real key, and the minted key round-trips", async () => {
  const run = await makeRun();
  const { agentEnv, minted } = await brokerizeAgentEnvForRun(
    { ANTHROPIC_API_KEY: "sk-ant-real-secret" },
    { aiRunId: run.id, agentModel: "claude-sonnet-5", hostEnv: BROKER_ON }
  );
  assert.deepEqual(minted, ["anthropic"]);
  assert.notEqual(agentEnv.ANTHROPIC_API_KEY, "sk-ant-real-secret");
  assert.match(agentEnv.ANTHROPIC_API_KEY!, /^rdocs-vk-/);
  assert.match(agentEnv.ANTHROPIC_BASE_URL!, /^http:\/\/host\.docker\.internal:14141\/api\/broker\//);

  const keyId = agentEnv.ANTHROPIC_BASE_URL!.split("/").pop()!;
  const resolution = await resolveBrokerRequest(keyId, agentEnv.ANTHROPIC_API_KEY!);
  assert.ok(resolution.ok);
  if (resolution.ok) {
    assert.equal(resolution.secretValue, "sk-ant-real-secret");
    assert.equal(resolution.authMode, "x-api-key");
    assert.equal(resolution.upstreamBaseUrl, "https://api.anthropic.com");
  }
});

test("brokerize is a no-op when the flag is off", async () => {
  const run = await makeRun();
  const { agentEnv, minted } = await brokerizeAgentEnvForRun(
    { ANTHROPIC_API_KEY: "sk-ant-real" },
    { aiRunId: run.id, agentModel: "claude-sonnet-5", hostEnv: {} }
  );
  assert.deepEqual(minted, []);
  assert.equal(agentEnv.ANTHROPIC_API_KEY, "sk-ant-real");
  assert.equal(agentEnv.ANTHROPIC_BASE_URL, undefined);
});

test("wrong token, finished run, revocation, and expiry are all rejected", async () => {
  const run = await makeRun();
  const { agentEnv } = await brokerizeAgentEnvForRun(
    { ANTHROPIC_API_KEY: "sk-ant-real" },
    { aiRunId: run.id, agentModel: "claude-sonnet-5", hostEnv: BROKER_ON }
  );
  const keyId = agentEnv.ANTHROPIC_BASE_URL!.split("/").pop()!;
  const token = agentEnv.ANTHROPIC_API_KEY!;

  const wrong = await resolveBrokerRequest(keyId, "rdocs-vk-" + "0".repeat(48));
  assert.ok(!wrong.ok && wrong.status === 401);

  const missingPrefix = await resolveBrokerRequest(keyId, "sk-ant-real");
  assert.ok(!missingPrefix.ok);

  // Finishing the run revokes the key AND flips the run status; both checks bite.
  await markAiRunSucceeded(run.id, {});
  const afterFinish = await resolveBrokerRequest(keyId, token);
  assert.ok(!afterFinish.ok && afterFinish.status === 401);
  const row = await db.agentBrokerKey.findUnique({ where: { id: keyId } });
  assert.ok(row?.revokedAt);
  assert.equal(row?.secret, null);

  // Expiry: fresh key on a RUNNING run, but past its expiresAt.
  const run2 = await makeRun();
  const env2 = (
    await brokerizeAgentEnvForRun(
      { ANTHROPIC_API_KEY: "sk-ant-real2" },
      { aiRunId: run2.id, agentModel: "claude-sonnet-5", hostEnv: BROKER_ON }
    )
  ).agentEnv;
  const keyId2 = env2.ANTHROPIC_BASE_URL!.split("/").pop()!;
  await db.agentBrokerKey.update({
    where: { id: keyId2 },
    data: { expiresAt: new Date(Date.now() - 1000) }
  });
  const expired = await resolveBrokerRequest(keyId2, env2.ANTHROPIC_API_KEY!);
  assert.ok(!expired.ok && expired.status === 401);

  const revokedCount = await revokeBrokerKeysForRun(run2.id);
  assert.equal(revokedCount, 1);
});

// --- proxy handler ----------------------------------------------------------

type Captured = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

function startFakeUpstream(): Promise<{ server: http.Server; url: string; last: () => Captured }> {
  let captured: Captured | null = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured = { method: req.method!, url: req.url!, headers: req.headers, body };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, last: () => captured! });
    });
  });
}

test("proxy swaps the virtual bearer token for the real credential", async () => {
  const upstream = await startFakeUpstream();
  try {
    const run = await makeRun();
    const token = `rdocs-vk-${crypto.randomBytes(24).toString("hex")}`;
    const key = await db.agentBrokerKey.create({
      data: {
        tokenHash: hashBrokerToken(token),
        aiRunId: run.id,
        provider: "litellm",
        upstreamBaseUrl: upstream.url,
        authMode: "authorization-bearer",
        secret: encryptSecret("real-upstream-key")
      }
    });

    const request = new Request(`http://localhost/api/broker/${key.id}/v1/messages?beta=1`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "anthropic-beta": "oauth-2025-04-20"
      },
      body: JSON.stringify({ hello: "world" }),
      // @ts-expect-error node fetch needs duplex for request bodies
      duplex: "half"
    });
    const response = await handleBrokerProxyRequest(request, key.id, ["v1", "messages"], {
      env: {}
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const seen = upstream.last();
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/v1/messages?beta=1");
    assert.equal(seen.headers.authorization, "Bearer real-upstream-key");
    assert.equal(seen.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(seen.body, JSON.stringify({ hello: "world" }));
  } finally {
    upstream.server.close();
  }
});

test("proxy swaps x-api-key mode and strips the incoming virtual auth headers", async () => {
  const upstream = await startFakeUpstream();
  try {
    const run = await makeRun();
    const token = `rdocs-vk-${crypto.randomBytes(24).toString("hex")}`;
    const key = await db.agentBrokerKey.create({
      data: {
        tokenHash: hashBrokerToken(token),
        aiRunId: run.id,
        provider: "anthropic",
        upstreamBaseUrl: upstream.url,
        authMode: "x-api-key",
        secret: encryptSecret("sk-ant-real")
      }
    });
    const request = new Request(`http://localhost/api/broker/${key.id}/v1/messages`, {
      method: "GET",
      headers: { "x-api-key": token, "cf-should-be-dropped": "no" }
    });
    // Header names starting cf- are stripped, but a bare cf-* custom header on a
    // DIRECT request must not be confused with Cloudflare provenance markers.
    const response = await handleBrokerProxyRequest(request, key.id, ["v1", "messages"], { env: {} });
    assert.equal(response.status, 200);
    const seen = upstream.last();
    assert.equal(seen.headers["x-api-key"], "sk-ant-real");
    assert.equal(seen.headers.authorization, undefined);
    assert.equal(seen.headers["cf-should-be-dropped"], undefined);
  } finally {
    upstream.server.close();
  }
});

test("proxy rejects Cloudflare-originated (public) requests and bad tokens", async () => {
  const publicReq = new Request("http://localhost/api/broker/k/v1/x", {
    headers: { "cf-ray": "abc", authorization: "Bearer rdocs-vk-x" }
  });
  const rejected = await handleBrokerProxyRequest(publicReq, "k", ["v1", "x"], { env: {} });
  assert.equal(rejected.status, 404);

  const badToken = new Request("http://localhost/api/broker/nope/v1/x", {
    headers: { authorization: "Bearer rdocs-vk-doesnotexist" }
  });
  const unauthorized = await handleBrokerProxyRequest(badToken, "nope", ["v1", "x"], { env: {} });
  assert.equal(unauthorized.status, 401);
});

// --- document env secret/config classification ------------------------------

test("isSecretEnvKey heuristic and explicit override", () => {
  assert.ok(isSecretEnvKey("OPENAI_API_KEY"));
  assert.ok(isSecretEnvKey("GH_TOKEN"));
  assert.ok(isSecretEnvKey("DB_PASSWORD"));
  assert.ok(!isSecretEnvKey("LITELLM_BASE_URL"));
  assert.ok(!isSecretEnvKey("LOCAL_MODEL_NAME"));
  assert.equal(effectiveIsSecret("LITELLM_BASE_URL", true), true);
  assert.equal(effectiveIsSecret("OPENAI_API_KEY", false), false);
  assert.equal(effectiveIsSecret("OPENAI_API_KEY", null), true);
});

test("config vars list in full, secrets masked, and the flag round-trips", async () => {
  const run = await makeRun();
  const documentId = run.documentId;
  await upsertDocumentEnv(documentId, "OPENAI_API_KEY", "sk-openai-super-secret");
  await upsertDocumentEnv(documentId, "LITELLM_BASE_URL", "http://litellm.example.com");

  let vars = await listDocumentEnvMasked(documentId);
  const secretVar = vars.find((v) => v.key === "OPENAI_API_KEY")!;
  const configVar = vars.find((v) => v.key === "LITELLM_BASE_URL")!;
  assert.equal(secretVar.isSecret, true);
  assert.equal(secretVar.isSecretAuto, true);
  assert.notEqual(secretVar.masked, "sk-openai-super-secret");
  assert.equal(configVar.isSecret, false);
  assert.equal(configVar.masked, "http://litellm.example.com");

  // Explicitly reclassify the URL as secret → masked; reset to auto → shown again.
  assert.ok(await setDocumentEnvSecretFlag(documentId, "LITELLM_BASE_URL", true));
  vars = await listDocumentEnvMasked(documentId);
  const reclassified = vars.find((v) => v.key === "LITELLM_BASE_URL")!;
  assert.equal(reclassified.isSecret, true);
  assert.equal(reclassified.isSecretAuto, false);
  assert.notEqual(reclassified.masked, "http://litellm.example.com");

  assert.ok(await setDocumentEnvSecretFlag(documentId, "LITELLM_BASE_URL", null));
  vars = await listDocumentEnvMasked(documentId);
  assert.equal(vars.find((v) => v.key === "LITELLM_BASE_URL")!.masked, "http://litellm.example.com");

  assert.equal(await setDocumentEnvSecretFlag(documentId, "NO_SUCH_VAR", true), false);
});
