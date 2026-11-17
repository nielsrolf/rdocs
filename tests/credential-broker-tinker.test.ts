import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

// Same-process key: broker rows created below are decrypted with this key.
process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

import {
  brokerizeAgentEnvForRun,
  planBrokerRewrites,
  resolveBrokerRequest,
  TINKER_DEFAULT_BASE_URL
} from "../lib/credential-broker";
import { handleBrokerProxyRequest, type RunBudgetState } from "../lib/credential-broker/proxy";
import { db } from "../lib/db";
import { forgetRunBudgetStates, runBudgetState } from "../lib/workspace-budget-state";

const BROKER_ON = { AGENT_CREDENTIAL_BROKER: "1", AGENT_RUNNER_MODE: "container" };
const created = { users: [] as string[], documents: [] as string[] };

async function makeRun() {
  const user = await db.user.create({
    data: { email: `tinker-broker-${crypto.randomUUID()}@example.com`, name: "broker", passwordHash: "x" }
  });
  created.users.push(user.id);
  const doc = await db.document.create({
    data: { title: "tinker broker test", content: JSON.stringify({ type: "doc", content: [] }), ownerId: user.id }
  });
  created.documents.push(doc.id);
  return db.aiRun.create({
    data: { documentId: doc.id, triggerType: "CONVERSATION", instruction: "t", status: "RUNNING" }
  });
}

test.after(async () => {
  await db.workspaceBudget.deleteMany({ where: { documentId: { in: created.documents } } });
  await db.document.deleteMany({ where: { id: { in: created.documents } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
  await db.$disconnect();
});

test("Tinker is brokered only when the deployment or the workspace opts in, and only for a static key", () => {
  const key = { TINKER_API_KEY: "tml-real-key" };
  const tinker = (env: Record<string, string>, host: Record<string, string> = {}) =>
    planBrokerRewrites(env, "claude-sonnet-latest", { hostEnv: host }).find((plan) => plan.provider === "tinker");

  assert.equal(tinker(key), undefined, "off by default");
  assert.equal(tinker({ TINKER_API_KEY: "eyJ.a.jwt", RDOCS_BROKER_TINKER: "1" }), undefined, "a JWT credential is left alone");

  const byWorkspace = tinker({ ...key, RDOCS_BROKER_TINKER: "1" });
  assert.ok(byWorkspace);
  assert.equal(byWorkspace.authMode, "x-api-key");
  assert.equal(byWorkspace.upstreamBaseUrl, TINKER_DEFAULT_BASE_URL);
  assert.deepEqual(byWorkspace.extraEnv("http://b/api/broker/k1"), { TINKER_BASE_URL: "http://b/api/broker/k1" });

  const byHost = tinker({ ...key, TINKER_BASE_URL: "https://tinker.example/staging" }, { AGENT_BROKER_TINKER: "1" });
  assert.equal(byHost?.upstreamBaseUrl, "https://tinker.example/staging");
});

/** A run with a brokered Tinker key, and a proxy call against a recording fake upstream. */
async function brokeredTinker(budget: RunBudgetState) {
  const run = await makeRun();
  const { agentEnv } = await brokerizeAgentEnvForRun(
    { TINKER_API_KEY: "tml-real-key", RDOCS_BROKER_TINKER: "1" },
    { aiRunId: run.id, agentModel: "claude-sonnet-latest", hostEnv: BROKER_ON }
  );
  const keyId = agentEnv.TINKER_BASE_URL.split("/").pop()!;
  const upstream: Array<{ url: string; apiKey: string | null; body: string }> = [];
  const call = (method: string, path: string, body?: unknown, respond: unknown = { ok: true }) =>
    handleBrokerProxyRequest(
      new Request(`http://localhost:14141/api/broker/${keyId}/${path}`, {
        method,
        headers: { "x-api-key": agentEnv.TINKER_API_KEY, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      }),
      keyId,
      path.split("/"),
      {
        env: {},
        runBudget: async () => budget,
        onUsage: async () => assert.fail("Tinker requests are not model calls: no usage event"),
        fetchImpl: (async (url: string, init: RequestInit) => {
          const sent = init.body ? new TextDecoder().decode(init.body as Uint8Array) : "";
          upstream.push({ url: String(url), apiKey: new Headers(init.headers).get("x-api-key"), body: sent });
          return Response.json(respond);
        }) as unknown as typeof fetch
      }
    );
  return { run, agentEnv, keyId, upstream, call };
}

test("the virtual Tinker key keeps the SDK's tml- prefix and resolves to the real key", async () => {
  const { agentEnv, keyId, upstream, call } = await brokeredTinker({ costsProject: null, exhausted: false });
  assert.match(agentEnv.TINKER_API_KEY, /^tml-rdocs-vk-[0-9a-f]{48}$/);
  const resolved = await resolveBrokerRequest(keyId, agentEnv.TINKER_API_KEY);
  assert.ok(resolved.ok);
  assert.equal(resolved.secretValue, "tml-real-key");
  assert.equal((await resolveBrokerRequest(keyId, "tml-real-key")).ok, false, "the real key is not a broker token");

  const response = await call("GET", "api/v1/get_server_capabilities");
  assert.equal(response.status, 200);
  assert.deepEqual(upstream[0], {
    url: `${TINKER_DEFAULT_BASE_URL}/api/v1/get_server_capabilities`,
    apiKey: "tml-real-key",
    body: ""
  });
});

test("a budgeted workspace's Tinker sessions are tagged with its cost project; JWT exchange is switched off", async () => {
  const { upstream, call } = await brokeredTinker({ costsProject: "run-42", exhausted: false });
  const session = { tags: [], user_metadata: { note: "mine", project: "someone-else" }, sdk_version: "0.33", type: "create_session" };
  await call("POST", "api/v1/create_session", session);
  assert.deepEqual(JSON.parse(upstream[0].body), { ...session, user_metadata: { note: "mine", project: "run-42" } });

  await call("POST", "api/v1/create_session", { tags: [], user_metadata: null, sdk_version: "0.33" });
  assert.deepEqual(JSON.parse(upstream[1].body).user_metadata, { project: "run-42" });

  // other requests pass through byte for byte
  await call("POST", "api/v1/asample", { user_metadata: { project: "kept" } });
  assert.deepEqual(JSON.parse(upstream[2].body), { user_metadata: { project: "kept" } });

  const config = await call("POST", "api/v1/client/config", {}, { pjwt_auth_enabled: true, credential_default_source: "api_key", other: 1 });
  assert.deepEqual(await config.json(), { pjwt_auth_enabled: false, credential_default_source: "api_key", other: 1 });
});

test("without a budget the session is left as the caller wrote it", async () => {
  const { upstream, call } = await brokeredTinker({ costsProject: null, exhausted: false });
  const session = { tags: [], user_metadata: { project: "own-choice" }, sdk_version: "0.33" };
  await call("POST", "api/v1/create_session", session);
  assert.deepEqual(JSON.parse(upstream[0].body), session);
});

test("a used-up budget stops every brokered request before it reaches the provider", async () => {
  const { upstream, call } = await brokeredTinker({ costsProject: "run-42", exhausted: true });
  const response = await call("POST", "api/v1/asample", {});
  assert.equal(response.status, 402);
  assert.equal((await response.json()).error.type, "budget_exhausted");
  assert.equal(upstream.length, 0);
});

test("runBudgetState: the workspace's cost project, and whether its budget is used up", async () => {
  const run = await makeRun();
  forgetRunBudgetStates();
  assert.deepEqual(await runBudgetState(run.id), { costsProject: null, exhausted: false });

  const budget = await db.workspaceBudget.create({
    data: { documentId: run.documentId, provisionerDocumentId: "p", costsProject: "run-42", budgetUsd: 5, createdById: "u" }
  });
  assert.deepEqual(await runBudgetState(run.id), { costsProject: null, exhausted: false }, "answers are cached briefly");
  forgetRunBudgetStates();
  assert.deepEqual(await runBudgetState(run.id), { costsProject: "run-42", exhausted: false });

  await db.workspaceBudget.update({ where: { id: budget.id }, data: { exhaustedAt: new Date() } });
  forgetRunBudgetStates();
  assert.deepEqual(await runBudgetState(run.id), { costsProject: "run-42", exhausted: true });
  assert.deepEqual(await runBudgetState(run.id, Date.now() + 60_000), { costsProject: "run-42", exhausted: true });

  await db.workspaceBudget.update({ where: { id: budget.id }, data: { closedAt: new Date() } });
  forgetRunBudgetStates();
  assert.deepEqual(await runBudgetState(run.id), { costsProject: null, exhausted: false }, "a closed budget no longer applies");
});
