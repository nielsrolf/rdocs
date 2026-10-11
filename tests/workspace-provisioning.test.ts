import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { db } from "../lib/db";
import { loadDocumentEnv, loadProvisionerEnv, upsertDocumentEnv } from "../lib/document-env";
import {
  verifyDocumentRunToken,
  withDocumentBridge,
  withWorkspacesBridge,
  WORKSPACES_BRIDGE_SERVER_NAME
} from "../lib/document-run-token";
import { handleMcpMessage } from "../lib/mcp/server";
import type { McpToolContext } from "../lib/mcp/tools";

process.env.SESSION_SECRET ||= "workspace-provisioning-test-secret";

const ORIGIN = "http://localhost:14141";

async function makeUser(prefix: string) {
  return db.user.create({
    data: { email: `${prefix}-${crypto.randomUUID()}@example.com`, name: prefix, passwordHash: "x" }
  });
}

async function makeDoc(ownerId: string, title = "Provisioning test doc") {
  return db.document.create({
    data: {
      title,
      content: JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }),
      ownerId,
      agentModel: "claude-opus-latest",
      agentEffort: "high"
    }
  });
}

function ctxFor(user: { id: string; email: string; name: string }, extra: Partial<McpToolContext> = {}): McpToolContext {
  return { user: { id: user.id, email: user.email, name: user.name }, origin: ORIGIN, ...extra };
}

async function callTool(ctx: McpToolContext, name: string, args: unknown) {
  const response = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    ctx
  );
  assert.ok(response && "result" in response, "tools/call must return a result");
  const result = response.result as { content: Array<{ type: string; text: string }>; isError: boolean };
  return { ...result, text: result.content[0].text, json: () => JSON.parse(result.content[0].text) };
}

test("create_workspace: child is owned by the parent's owner, the creator gets edit, env is handed on by name", async () => {
  const owner = await makeUser("prov-owner");
  const collaborator = await makeUser("prov-collab");
  const parent = await makeDoc(owner.id, "Master");
  await db.documentMembership.create({ data: { documentId: parent.id, userId: collaborator.id, permission: "EDIT" } });
  await upsertDocumentEnv(parent.id, "OPENWEIGHTS_API_KEY", "ow_secret_value");
  await upsertDocumentEnv(parent.id, "LITELLM_ADMIN_KEY", "sk-admin-secret");

  const result = await callTool(ctxFor(collaborator), "create_workspace", {
    parent: parent.id,
    title: "Project A",
    markdown: "# Project A\n\nBrief.",
    environment: { PROJECT_NAME: "a" },
    inherit_env: ["OPENWEIGHTS_API_KEY"]
  });
  assert.equal(result.isError, false, result.text);
  assert.ok(!result.text.includes("ow_secret_value"), "inherited values never come back to the caller");
  const created = result.json();
  assert.deepEqual(created.env_keys, ["OPENWEIGHTS_API_KEY", "PROJECT_NAME"]);

  const child = await db.document.findUniqueOrThrow({ where: { id: created.id } });
  assert.equal(child.ownerId, owner.id);
  assert.equal(child.parentDocumentId, parent.id);
  assert.equal(child.agentModel, "claude-opus-latest");
  assert.equal(child.agentEffort, "high");
  const membership = await db.documentMembership.findUnique({
    where: { documentId_userId: { documentId: child.id, userId: collaborator.id } }
  });
  assert.equal(membership?.permission, "EDIT");
  const childEnv = await loadDocumentEnv(child.id);
  assert.equal(childEnv.OPENWEIGHTS_API_KEY, "ow_secret_value");
  assert.equal(childEnv.PROJECT_NAME, "a");

  const listed = (await callTool(ctxFor(collaborator), "list_child_workspaces", { parent: parent.id })).json();
  assert.deepEqual(
    listed.workspaces.map((w: { id: string; your_access: string }) => [w.id, w.your_access]),
    [[child.id, "edit"]]
  );
});

test("create_workspace refuses viewers, unknown keys and provisioner admin secrets", async () => {
  const owner = await makeUser("prov-owner2");
  const viewer = await makeUser("prov-viewer");
  const parent = await makeDoc(owner.id);
  await db.documentMembership.create({ data: { documentId: parent.id, userId: viewer.id, permission: "VIEW" } });
  await upsertDocumentEnv(parent.id, "HF_TOKEN", "hf_x");
  await upsertDocumentEnv(parent.id, "LITELLM_ADMIN_KEY", "sk-admin-secret");

  const byViewer = await callTool(ctxFor(viewer), "create_workspace", { parent: parent.id, title: "nope" });
  assert.equal(byViewer.isError, true);
  assert.match(byViewer.text, /edit access/);

  const before = await db.document.count({ where: { parentDocumentId: parent.id } });
  const missing = await callTool(ctxFor(owner), "create_workspace", {
    parent: parent.id,
    title: "missing key",
    inherit_env: ["OPENAI_API_KEY"]
  });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /OPENAI_API_KEY/);
  assert.match(missing.text, /Available keys: HF_TOKEN/, "available keys are named, admin secret is not");
  assert.ok(!missing.text.includes("LITELLM_ADMIN_KEY"));
  assert.equal(await db.document.count({ where: { parentDocumentId: parent.id } }), before, "failed create is rolled back");

  const admin = await callTool(ctxFor(owner), "create_workspace", {
    parent: parent.id,
    title: "steal admin",
    inherit_env: ["LITELLM_ADMIN_KEY"]
  });
  assert.equal(admin.isError, true);
  assert.match(admin.text, /provisioner admin secret/);
});

test("provisioner admin secrets are withheld from every run env", async () => {
  const owner = await makeUser("prov-withheld");
  const doc = await makeDoc(owner.id);
  await upsertDocumentEnv(doc.id, "LITELLM_ADMIN_KEY", "sk-admin-secret");
  await upsertDocumentEnv(doc.id, "OTHER", "1");
  assert.deepEqual(await loadDocumentEnv(doc.id), { OTHER: "1" });
  assert.equal((await loadProvisionerEnv(doc.id)).LITELLM_ADMIN_KEY, "sk-admin-secret");
});

test("a confined run may create children of its own document and manage them, nothing else", async () => {
  const owner = await makeUser("prov-scope");
  const parent = await makeDoc(owner.id, "Scoped master");
  const unrelated = await makeDoc(owner.id, "Unrelated");
  await upsertDocumentEnv(parent.id, "MODAL_TOKEN_ID", "ak-1");
  const ctx = ctxFor(owner, { scopeDocumentId: parent.id });

  const elsewhere = await callTool(ctx, "create_workspace", { parent: unrelated.id, title: "x" });
  assert.equal(elsewhere.isError, true);

  const created = await callTool(ctx, "create_workspace", { parent: parent.id, title: "Child" });
  assert.equal(created.isError, false, created.text);
  const childId = created.json().id;

  const set = await callTool(ctx, "set_workspace_env", {
    document: childId,
    set: { REGION: "eu" },
    copy_from: { document: parent.id, keys: ["MODAL_TOKEN_ID"] }
  });
  assert.equal(set.isError, false, set.text);
  assert.deepEqual(await loadDocumentEnv(childId), { MODAL_TOKEN_ID: "ak-1", REGION: "eu" });

  const readChild = await callTool(ctx, "read_document", { document: childId });
  assert.equal(readChild.isError, false, readChild.text);
  const readUnrelated = await callTool(ctx, "read_document", { document: unrelated.id });
  assert.equal(readUnrelated.isError, true);
  assert.equal((await callTool(ctx, "create_document", { title: "x" })).isError, true);
});

test("the workspaces toolset exposes only provisioning tools", async () => {
  const owner = await makeUser("prov-toolset");
  const doc = await makeDoc(owner.id);
  const ctx = ctxFor(owner, { scopeDocumentId: doc.id, toolset: "workspaces" });
  const list = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx);
  assert.ok(list && "result" in list);
  const names = (list.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "create_workspace",
    "list_child_workspaces",
    "list_litellm_keys",
    "list_workspace_env",
    "provision_litellm_key",
    "revoke_litellm_key",
    "set_workspace_env",
    "update_litellm_key"
  ]);
  const edit = await callTool(ctx, "replace_document", { document: doc.id, markdown: "x" });
  assert.equal(edit.isError, true);
  assert.match(edit.text, /not available/);
});

test("withWorkspacesBridge mounts a toolset-limited token, and defers to an existing doc bridge", async () => {
  const claims = { userId: "u1", documentId: "d1", aiRunId: "r1" };
  const servers = await withWorkspacesBridge([], claims);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, WORKSPACES_BRIDGE_SERVER_NAME);
  const token = (servers[0] as { headers: Record<string, string> }).headers.Authorization.replace("Bearer ", "");
  assert.deepEqual(await verifyDocumentRunToken(token), { ...claims, toolset: "workspaces" });

  const headless = await withDocumentBridge(undefined, claims);
  assert.equal((await withWorkspacesBridge(headless, claims)).length, 1, "a headless run's doc bridge already has the tools");
});

// ---------------------------------------------------------------------------
// LiteLLM key provisioning against a fake proxy

type Recorded = { method: string; path: string; auth: string | undefined; body: Record<string, unknown> | null };

async function startFakeLiteLlm() {
  const requests: Recorded[] = [];
  let counter = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      requests.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "Bearer sk-admin-secret") {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "bad admin key" }));
        return;
      }
      if (req.url === "/key/generate") {
        counter += 1;
        res.end(JSON.stringify({ key: `sk-minted-${counter}`, key_alias: body?.key_alias }));
      } else if (req.url?.startsWith("/key/info")) {
        res.end(JSON.stringify({ info: { spend: 3.5, max_budget: 20, budget_duration: "30d", models: [], blocked: false } }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { requests, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test("provision_litellm_key mints a budgeted key into the target env without exposing it, and manages it", async () => {
  const fake = await startFakeLiteLlm();
  try {
    const owner = await makeUser("prov-litellm");
    const outsider = await makeUser("prov-outsider");
    const master = await makeDoc(owner.id, "Master");
    await upsertDocumentEnv(master.id, "LITELLM_ADMIN_KEY", "sk-admin-secret");
    await upsertDocumentEnv(master.id, "LITELLM_ADMIN_BASE_URL", fake.url);
    await upsertDocumentEnv(master.id, "LITELLM_PROVISION_MAX_BUDGET_USD", "50");
    const ctx = ctxFor(owner, { scopeDocumentId: master.id });
    const child = (await callTool(ctx, "create_workspace", { parent: master.id, title: "Project" })).json();

    const overCap = await callTool(ctx, "provision_litellm_key", {
      provisioner: master.id,
      document: child.id,
      max_budget_usd: 100
    });
    assert.equal(overCap.isError, true);
    assert.match(overCap.text, /cap of 50/);
    assert.equal(fake.requests.length, 0, "the cap is enforced before calling the proxy");

    const minted = await callTool(ctx, "provision_litellm_key", {
      provisioner: master.id,
      document: child.id,
      max_budget_usd: 20,
      budget_duration: "30d",
      models: ["anthropic/claude-sonnet-5-5"]
    });
    assert.equal(minted.isError, false, minted.text);
    assert.ok(!minted.text.includes("sk-minted"), "the minted key is not returned");
    assert.ok(!minted.text.includes("sk-admin"), "the admin key is not returned");
    const generate = fake.requests.find((r) => r.path === "/key/generate");
    assert.equal(generate?.auth, "Bearer sk-admin-secret");
    assert.equal(generate?.body?.max_budget, 20);
    assert.equal(generate?.body?.budget_duration, "30d");
    assert.deepEqual(generate?.body?.models, ["anthropic/claude-sonnet-5-5"]);
    assert.equal((generate?.body?.metadata as Record<string, string>).rdocs_target_document_id, child.id);
    assert.equal((await loadDocumentEnv(child.id)).LITELLM_API_KEY, "sk-minted-1");

    const again = await callTool(ctx, "provision_litellm_key", { provisioner: master.id, document: child.id, max_budget_usd: 5 });
    assert.equal(again.isError, true);
    assert.match(again.text, /replace=true/);

    const replaced = await callTool(ctx, "provision_litellm_key", {
      provisioner: master.id,
      document: child.id,
      max_budget_usd: 5,
      replace: true
    });
    assert.equal(replaced.isError, false, replaced.text);
    assert.equal((await loadDocumentEnv(child.id)).LITELLM_API_KEY, "sk-minted-2");
    const deleted = fake.requests.find((r) => r.path === "/key/delete");
    assert.deepEqual(deleted?.body, { keys: ["sk-minted-1"] }, "the replaced key is deleted at the proxy");

    const listed = (await callTool(ctx, "list_litellm_keys", { provisioner: master.id })).json();
    assert.equal(listed.keys.length, 1);
    assert.equal(listed.keys[0].document, child.id);
    assert.equal(listed.keys[0].spend_usd, 3.5);
    assert.ok(!JSON.stringify(listed).includes("sk-minted"));

    const updated = await callTool(ctx, "update_litellm_key", {
      provisioner: master.id,
      document: child.id,
      max_budget_usd: 40,
      blocked: true
    });
    assert.equal(updated.isError, false, updated.text);
    assert.deepEqual(fake.requests.find((r) => r.path === "/key/update")?.body, { key: "sk-minted-2", max_budget: 40 });
    assert.ok(fake.requests.some((r) => r.path === "/key/block"));

    const outsiderTry = await callTool(ctxFor(outsider), "provision_litellm_key", {
      provisioner: master.id,
      document: child.id,
      max_budget_usd: 1
    });
    assert.equal(outsiderTry.isError, true, "no access to the provisioner → no minting");

    const revoked = await callTool(ctx, "revoke_litellm_key", { provisioner: master.id, document: child.id });
    assert.equal(revoked.isError, false, revoked.text);
    assert.equal((await loadDocumentEnv(child.id)).LITELLM_API_KEY, undefined);
    assert.deepEqual(fake.requests.filter((r) => r.path === "/key/delete").at(-1)?.body, { keys: ["sk-minted-2"] });
    assert.equal((await callTool(ctx, "list_litellm_keys", { provisioner: master.id })).json().keys.length, 0);
  } finally {
    await fake.close();
  }
});

test("a document without LITELLM_ADMIN_KEY is not a provisioner", async () => {
  const owner = await makeUser("prov-none");
  const doc = await makeDoc(owner.id);
  const result = await callTool(ctxFor(owner), "provision_litellm_key", { provisioner: doc.id, document: doc.id, max_budget_usd: 1 });
  assert.equal(result.isError, true);
  assert.match(result.text, /not a LiteLLM provisioner/);
});
