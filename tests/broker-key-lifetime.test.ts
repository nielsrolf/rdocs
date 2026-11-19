import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

import { db } from "../lib/db";
import {
  bindBrokerKeysToContainer,
  brokerizeAgentEnvForRun,
  reconcileContainerBoundBrokerKeys,
  resolveBrokerRequest,
  revokeBrokerKeysForContainer,
  revokeBrokerKeysForRun,
  revokeBrokerKeysOfFinishedRuns
} from "../lib/credential-broker";
import { handleBrokerProxyRequest } from "../lib/credential-broker/proxy";
import { durableContainerName, stopDurableContainer } from "../lib/durable-apps";
import { markAiRunSucceeded } from "../lib/ai-runs";

// A virtual key lives as long as the container its run executed in: with the
// run for a per-run container, beyond it for a workspace's durable container,
// and never longer than the container.

const created = { users: [] as string[], documents: [] as string[] };
const HOST = { AGENT_CREDENTIAL_BROKER: "1", AGENT_BROKER_BASE_URL: "http://broker" };
const ENV = {
  GITHUB_TOKEN: `ghp_${"lifetimeTest".padEnd(36, "x")}`,
  HF_TOKEN: `hf_${"lifetimeTest".padEnd(34, "x")}`,
  LITELLM_API_KEY: "sk-litellm-lifetime-test-key-000000000000",
  LITELLM_BASE_URL: "http://litellm.invalid"
};

async function makeRun() {
  const user = await db.user.create({
    data: { email: `lifetime-${crypto.randomUUID()}@example.com`, name: "l", passwordHash: "x" }
  });
  created.users.push(user.id);
  const doc = await db.document.create({
    data: { title: "key lifetime", content: JSON.stringify({ type: "doc", content: [] }), ownerId: user.id }
  });
  created.documents.push(doc.id);
  const run = await db.aiRun.create({
    data: { documentId: doc.id, triggerType: "CONVERSATION", instruction: "t", status: "RUNNING" }
  });
  const { agentEnv, minted } = await brokerizeAgentEnvForRun(ENV, { aiRunId: run.id, agentModel: "claude-sonnet-5", hostEnv: HOST });
  assert.deepEqual(minted.sort(), ["github", "huggingface", "litellm"]);
  const keys = {
    github: { id: agentEnv.RDOCS_GITHUB_BROKER_URL.split("/").pop()!, token: agentEnv.GITHUB_TOKEN },
    huggingface: { id: agentEnv.HF_ENDPOINT.split("/").pop()!, token: agentEnv.HF_TOKEN },
    litellm: { id: agentEnv.LITELLM_BASE_URL.split("/").pop()!, token: agentEnv.LITELLM_API_KEY }
  };
  return { run, doc, keys };
}

type Keys = Awaited<ReturnType<typeof makeRun>>["keys"];
async function usable(keys: Keys) {
  const out: Record<string, boolean> = {};
  for (const [provider, key] of Object.entries(keys)) out[provider] = (await resolveBrokerRequest(key.id, key.token)).ok;
  return out;
}
const ALL = { github: true, huggingface: true, litellm: true };
const NONE = { github: false, huggingface: false, litellm: false };

test.after(async () => {
  await db.document.deleteMany({ where: { id: { in: created.documents } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
  await db.$disconnect();
});

test("a per-run container: the keys end with the run, on every way a run ends", async () => {
  for (const status of ["SUCCEEDED", "FAILED", "CANCELLED"]) {
    const { run, keys } = await makeRun();
    assert.deepEqual(await usable(keys), ALL);
    await db.aiRun.update({ where: { id: run.id }, data: { status } });
    assert.deepEqual(await usable(keys), NONE, `refused once the run is ${status}, even before the revoke`);
    assert.equal(await revokeBrokerKeysForRun(run.id), 3);
    const rows = await db.agentBrokerKey.findMany({ where: { aiRunId: run.id } });
    assert.ok(rows.every((row) => row.revokedAt && row.secret === null), "the stored secrets are wiped");
  }
  // A run that succeeds is revoked on the spot …
  const done = await makeRun();
  await markAiRunSucceeded(done.run.id, {});
  assert.equal(await db.agentBrokerKey.count({ where: { aiRunId: done.run.id, revokedAt: null } }), 0);
  // … one that failed or was cancelled is refused at once and wiped by the sweep.
  const failed = await makeRun();
  const running = await makeRun();
  await db.aiRun.update({ where: { id: failed.run.id }, data: { status: "FAILED" } });
  assert.deepEqual(await usable(failed.keys), NONE);
  assert.ok((await revokeBrokerKeysOfFinishedRuns()) >= 3);
  assert.equal(await db.agentBrokerKey.count({ where: { aiRunId: failed.run.id, secret: { not: null } } }), 0);
  assert.deepEqual(await usable(running.keys), ALL, "a live run is not touched");
});

test("a durable container: the keys outlive the run and end with the container", async () => {
  const { run, keys } = await makeRun();
  const name = durableContainerName(`ws-${crypto.randomUUID()}`);
  assert.equal(await bindBrokerKeysToContainer(run.id, name), 3);
  const bound = await db.agentBrokerKey.findMany({ where: { aiRunId: run.id } });
  assert.ok(bound.every((row) => row.containerName === name && row.expiresAt === null), "no time limit: the container's end is the limit");

  // The run ends the usual way; what it left running keeps its access.
  await markAiRunSucceeded(run.id, {});
  assert.equal(await revokeBrokerKeysForRun(run.id), 0);
  assert.equal(await revokeBrokerKeysOfFinishedRuns() >= 0, true);
  assert.deepEqual(await usable(keys), ALL);

  // A second run in the same container does not disturb the first one's keys.
  const later = await makeRun();
  await bindBrokerKeysToContainer(later.run.id, name);
  await db.aiRun.update({ where: { id: later.run.id }, data: { status: "SUCCEEDED" } });
  assert.deepEqual(await usable(keys), ALL);
  assert.deepEqual(await usable(later.keys), ALL);

  // The container goes: every key that lived in it goes too, and nothing else.
  const other = await makeRun();
  assert.equal(await revokeBrokerKeysForContainer(name), 6);
  assert.deepEqual(await usable(keys), NONE);
  assert.deepEqual(await usable(later.keys), NONE);
  assert.deepEqual(await usable(other.keys), ALL);
  const rows = await db.agentBrokerKey.findMany({ where: { containerName: name } });
  assert.ok(rows.every((row) => row.revokedAt && row.secret === null));
});

test("removing a durable container (restart, reconfiguration) revokes its keys", async () => {
  const { run, keys } = await makeRun();
  const workspaceId = `ws-${crypto.randomUUID()}`;
  await bindBrokerKeysToContainer(run.id, durableContainerName(workspaceId));
  await db.aiRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED" } });
  assert.deepEqual(await usable(keys), ALL);
  // `true` stands in for the container runtime: `rm -f <name>` succeeds without Docker.
  await stopDurableContainer(workspaceId, "true");
  assert.deepEqual(await usable(keys), NONE);
});

test("the sweep revokes keys of a container that vanished behind the app's back, and only those", async () => {
  const gone = await makeRun();
  const alive = await makeRun();
  const goneName = `gdocs-durable-gone-${crypto.randomUUID()}`;
  const aliveName = `gdocs-durable-alive-${crypto.randomUUID()}`;
  await bindBrokerKeysToContainer(gone.run.id, goneName);
  await bindBrokerKeysToContainer(alive.run.id, aliveName);
  await db.aiRun.updateMany({ where: { id: { in: [gone.run.id, alive.run.id] } }, data: { status: "SUCCEEDED" } });

  // The runtime cannot be asked: nothing is concluded from that.
  const blind = await reconcileContainerBoundBrokerKeys({ exec: async () => ({ code: 1, stdout: "" }) });
  assert.deepEqual(blind.revoked, []);
  assert.deepEqual(await usable(gone.keys), ALL);

  const calls: string[][] = [];
  const swept = await reconcileContainerBoundBrokerKeys({
    exec: async (_cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: `${aliveName}\ngdocs-run-something-else\n` };
    }
  });
  assert.deepEqual(calls, [["ps", "--format", "{{.Names}}"]], "running containers only: a stopped one runs nothing");
  assert.ok(swept.revoked.includes(goneName) && !swept.revoked.includes(aliveName));
  assert.deepEqual(await usable(gone.keys), NONE);
  assert.deepEqual(await usable(alive.keys), ALL);
  await revokeBrokerKeysForContainer(aliveName);
});

test("a workspace budget still stops spend through a key that outlived its run", async () => {
  const { run, keys } = await makeRun();
  await bindBrokerKeysToContainer(run.id, `gdocs-durable-budget-${crypto.randomUUID()}`);
  await db.aiRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED" } });
  const response = await handleBrokerProxyRequest(
    new Request(`http://broker/api/broker/${keys.litellm.id}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${keys.litellm.token}`, "content-type": "application/json" },
      body: "{}"
    }),
    keys.litellm.id,
    ["v1", "chat", "completions"],
    { env: {}, runBudget: async () => ({ costsProject: "p", exhausted: true }) }
  );
  assert.equal(response.status, 402);
});
