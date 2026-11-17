import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { costsProjectName } from "../lib/costs-client";
import { db } from "../lib/db";
import { loadDocumentEnv, loadProvisionerEnv, upsertDocumentEnv } from "../lib/document-env";
import { handleMcpMessage } from "../lib/mcp/server";
import { enforceWorkspaceBudgets, liteLlmAllowance } from "../lib/workspace-budget-enforcement";
import { assertWorkspaceBudgetAvailable, runBudgetState } from "../lib/workspace-budget-state";
import type { McpToolContext } from "../lib/mcp/tools";

process.env.SESSION_SECRET ||= "workspace-budget-test-secret";

const ORIGIN = "http://localhost:14141";

async function makeUser(prefix: string) {
  return db.user.create({
    data: { email: `${prefix}-${crypto.randomUUID()}@example.com`, name: prefix, passwordHash: "x" }
  });
}

async function makeDoc(ownerId: string, title = "Budget test doc", parentDocumentId: string | null = null) {
  return db.document.create({
    data: {
      title,
      content: JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }),
      ownerId,
      parentDocumentId
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

type Recorded = { method: string; path: string; auth: string | undefined; body: Record<string, unknown> | null };

/**
 * One server standing in for the three services a budget touches: the cost
 * dashboard (/api/projects…), the LiteLLM proxy (/key/…) and OpenWeights'
 * Supabase REST API (/rest/v1/rpc/…).
 */
async function startFakeProviders() {
  const requests: Recorded[] = [];
  const projects = new Map<string, Record<string, unknown>>();
  const fail = new Set<string>(); // rpc or path names that answer 500
  let counter = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const path = req.url ?? "";
      requests.push({ method: req.method ?? "", path, auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      const send = (status: number, payload: unknown) => {
        res.statusCode = status;
        res.end(JSON.stringify(payload));
      };
      if ([...fail].some((name) => path.endsWith(name))) return send(500, { detail: "provider is down" });

      // --- cost dashboard
      if (path.startsWith("/api/projects")) {
        if (req.headers.authorization !== "Bearer ct_costs_token") return send(401, { detail: "bad token" });
        const name = decodeURIComponent(path.split("/")[3] ?? "");
        if (req.method === "POST" && path === "/api/projects") {
          const key = String(body?.name);
          if (!projects.has(key)) projects.set(key, { ...body, closed_at: null });
          return send(201, projects.get(key));
        }
        const project = projects.get(name);
        if (!project) return send(404, { detail: `no project '${name}'` });
        if (req.method === "PATCH") {
          Object.assign(project, body);
          return send(200, project);
        }
        if (req.method === "DELETE") {
          projects.delete(name);
          return send(200, { deleted: 1 });
        }
        if (req.method === "GET" && path.endsWith("/spend")) {
          const budget = Number(project.budget_usd);
          return send(200, {
            name,
            parent: project.parent,
            path: [project.parent, name],
            budget_usd: budget,
            spent_usd: 61,
            estimated_usd: 43,
            remaining_usd: budget - 61,
            over_budget: budget <= 61,
            limits: [{ project: name, budget_usd: budget, spent_usd: 61, remaining_usd: budget - 61 }],
            by_provider: [
              { provider: "tinker", usd: 43, estimated_usd: 43 },
              { provider: "litellm", usd: 18, estimated_usd: 0 }
            ],
            synced_at: { tinker: "2026-11-17T10:00:00+00:00", litellm: "2026-11-17T10:05:00+00:00" },
            closed_at: null
          });
        }
      }

      // --- LiteLLM proxy
      if (path.startsWith("/key/")) {
        if (req.headers.authorization !== "Bearer sk-admin-secret") return send(401, { error: "bad admin key" });
        if (path === "/key/generate") return send(200, { key: `sk-minted-${++counter}` });
        return send(200, {});
      }

      // --- OpenWeights (Supabase REST)
      if (path.startsWith("/rest/v1/rpc/")) {
        if (req.headers.apikey !== "anon-key") return send(401, { message: "no apikey" });
        const rpc = path.split("/").pop();
        if (rpc === "exchange_api_token_for_jwt") {
          return body?.api_token === "ow_admin_secret" ? send(200, "jwt-for-org") : send(401, { message: "bad token" });
        }
        if (req.headers.authorization !== "Bearer jwt-for-org") return send(401, { message: "bad jwt" });
        if (rpc === "get_organization_from_token") return send(200, "org-1");
        if (rpc === "create_api_token_with_limit") {
          return send(200, [{ token_id: `tok-${++counter}`, token: `ow_minted_${counter}` }]);
        }
        return send(200, null);
      }
      send(404, { detail: "unknown path" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    projects,
    fail,
    calls: (suffix: string) => requests.filter((request) => request.path.endsWith(suffix)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

type Fake = Awaited<ReturnType<typeof startFakeProviders>>;

/** A provisioner with every provider configured. */
async function makeProvisioner(fake: Fake, ownerId: string) {
  const provisioner = await makeDoc(ownerId, "Compute account");
  const env: Record<string, string> = {
    COSTS_ADMIN_TOKEN: "ct_costs_token",
    COSTS_API_URL: fake.url,
    COSTS_PARENT_PROJECT: "backlog",
    LITELLM_ADMIN_KEY: "sk-admin-secret",
    LITELLM_ADMIN_BASE_URL: fake.url,
    // an ordinary organization key: OpenWeights has no separate admin keys
    OPENWEIGHTS_API_KEY: "ow_admin_secret",
    OPENWEIGHTS_SUPABASE_URL: fake.url,
    OPENWEIGHTS_SUPABASE_ANON_KEY: "anon-key",
    TINKER_API_KEY: "tml-shared-tinker",
    MODAL_TOKEN_ID: "ak-shared",
    MODAL_TOKEN_SECRET: "as-shared"
  };
  for (const [key, value] of Object.entries(env)) await upsertDocumentEnv(provisioner.id, key, value);
  return provisioner;
}

const SECRETS = ["ct_costs_token", "sk-admin-secret", "ow_admin_secret", "sk-minted", "ow_minted", "tml-shared", "as-shared"];
function assertNoSecrets(text: string) {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `the tool result must not contain ${secret}`);
}

test("create_workspace with budget_usd: a cost project, minted keys with that limit, shared keys handed on", async () => {
  const fake = await startFakeProviders();
  try {
    const owner = await makeUser("budget-owner");
    const provisioner = await makeProvisioner(fake, owner.id);
    const ctx = ctxFor(owner);

    const result = await callTool(ctx, "create_workspace", {
      parent: provisioner.id,
      title: "Backlog run: Sparse probes!",
      budget_usd: 1000
    });
    assert.equal(result.isError, false, result.text);
    assertNoSecrets(result.text);
    const created = result.json();
    const project = costsProjectName("Backlog run: Sparse probes!", created.id);
    assert.match(project, /^backlog-run-sparse-probes-[a-z0-9]{6}$/);
    assert.deepEqual(created.budget, {
      budget_usd: 1000,
      cost_project: project,
      cost_project_parent: "backlog",
      providers: { litellm: "minted", openweights: "minted", tinker: "shared", modal: "shared" }
    });
    assert.deepEqual(created.env_keys, [
      "COSTS_PROJECT",
      "LITELLM_API_KEY",
      "MODAL_TOKEN_ID",
      "MODAL_TOKEN_SECRET",
      "OPENWEIGHTS_API_KEY",
      "RDOCS_BROKER_TINKER",
      "TINKER_API_KEY"
    ]);

    // what each service was asked for
    const [registered] = fake.calls("/api/projects");
    assert.deepEqual(
      { name: registered.body?.name, parent: registered.body?.parent, budget: registered.body?.budget_usd, ref: registered.body?.external_ref },
      { name: project, parent: "backlog", budget: 1000, ref: `rdocs:${created.id}` }
    );
    const [generated] = fake.calls("/key/generate");
    assert.equal(generated.body?.max_budget, 1000);
    assert.equal((generated.body?.metadata as Record<string, unknown>).costs_project, project);
    const [token] = fake.calls("/create_api_token_with_limit");
    assert.deepEqual(token.body, {
      org_id: "org-1",
      token_name: project,
      expires_at: null,
      spending_limit_usd: "1000"
    });

    // the workspace's runs get its own keys; the provisioner's runs never get the admin secrets
    assert.deepEqual(await loadDocumentEnv(created.id), {
      COSTS_PROJECT: project,
      LITELLM_API_KEY: "sk-minted-1",
      MODAL_TOKEN_ID: "ak-shared",
      MODAL_TOKEN_SECRET: "as-shared",
      OPENWEIGHTS_API_KEY: "ow_minted_2",
      RDOCS_BROKER_TINKER: "1",
      TINKER_API_KEY: "tml-shared-tinker"
    });
    const provisionerRunEnv = await loadDocumentEnv(provisioner.id);
    for (const key of ["COSTS_ADMIN_TOKEN", "LITELLM_ADMIN_KEY", "OPENWEIGHTS_ADMIN_KEY"]) {
      assert.equal(provisionerRunEnv[key], undefined, `${key} must not reach an agent run`);
    }
    assert.equal((await loadProvisionerEnv(provisioner.id)).COSTS_ADMIN_TOKEN, "ct_costs_token");

    const budget = await db.workspaceBudget.findUniqueOrThrow({ where: { documentId: created.id } });
    assert.equal(budget.budgetUsd, 1000);
    assert.equal(budget.provisionerDocumentId, provisioner.id);
    const credentials = await db.provisionedCredential.findMany({
      where: { targetDocumentId: created.id, revokedAt: null },
      orderBy: { provider: "asc" }
    });
    assert.deepEqual(
      credentials.map((row) => [row.provider, row.envKey, row.maxBudgetUsd, row.externalId]),
      [
        ["litellm", "LITELLM_API_KEY", 1000, null],
        ["openweights", "OPENWEIGHTS_API_KEY", 1000, "tok-2"]
      ]
    );

    // spend, as the dashboard reports it
    const status = await callTool(ctx, "get_workspace_budget", { document: created.id });
    assert.equal(status.isError, false, status.text);
    assertNoSecrets(status.text);
    const reported = status.json().budget;
    assert.equal(reported.spent_usd, 61);
    assert.equal(reported.remaining_usd, 939);
    assert.deepEqual(
      reported.by_provider.map((entry: { provider: string; usd: number }) => [entry.provider, entry.usd]),
      [["tinker", 43], ["litellm", 18]]
    );
    assert.equal(reported.synced_at.tinker, "2026-11-17T10:00:00+00:00");

    // changing the budget: dashboard, LiteLLM key, OpenWeights token
    const raised = await callTool(ctx, "set_workspace_budget", { document: created.id, budget_usd: 1500 });
    assert.equal(raised.isError, false, raised.text);
    assert.deepEqual(raised.json().warnings, []);
    assert.equal(fake.projects.get(project)?.budget_usd, 1500);
    assert.deepEqual(fake.calls("/key/update")[0].body, { key: "sk-minted-1", max_budget: 1500 });
    assert.deepEqual(fake.calls("/set_spending_limit")[0].body, { org_id: "org-1", key_id: "tok-2", amount_usd: "1500" });
    assert.equal((await db.workspaceBudget.findUniqueOrThrow({ where: { documentId: created.id } })).budgetUsd, 1500);

    // a provider that refuses keeps its old limit and is named
    fake.fail.add("/set_spending_limit");
    const partly = await callTool(ctx, "set_workspace_budget", { document: created.id, budget_usd: 2000 });
    assert.equal(partly.isError, false, partly.text);
    assert.equal(partly.json().warnings.length, 1);
    assert.match(partly.json().warnings[0], /OpenWeights token limit not changed/);
    assert.equal(fake.projects.get(project)?.budget_usd, 2000);

    // one budget per workspace
    const again = await callTool(ctx, "set_workspace_budget", { document: created.id, budget_usd: 5, provisioner: created.id });
    assert.equal(again.isError, true);
  } finally {
    await fake.close();
  }
});

test("a failed provisioning leaves nothing behind", async () => {
  const fake = await startFakeProviders();
  try {
    const owner = await makeUser("budget-rollback");
    const provisioner = await makeProvisioner(fake, owner.id);
    fake.fail.add("/create_api_token_with_limit");

    const result = await callTool(ctxFor(owner), "create_workspace", {
      parent: provisioner.id,
      title: "Doomed",
      budget_usd: 100
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /create_api_token_with_limit returned 500/);
    assert.equal(await db.document.count({ where: { parentDocumentId: provisioner.id } }), 0, "no workspace without its budget");
    assert.equal(fake.projects.size, 0, "the cost project is deleted again");
    assert.deepEqual(fake.calls("/key/delete")[0].body, { keys: ["sk-minted-1"] });
    assert.equal(await db.workspaceBudget.count({ where: { provisionerDocumentId: provisioner.id } }), 0);
  } finally {
    await fake.close();
  }
});

test("only what the provisioner has is set up; caps and missing configuration are refused", async () => {
  const fake = await startFakeProviders();
  try {
    const owner = await makeUser("budget-partial");
    const provisioner = await makeDoc(owner.id, "Tinker only");
    const ctx = ctxFor(owner);

    // no dashboard token: not a place budgets can come from
    const refused = await callTool(ctx, "create_workspace", { parent: provisioner.id, title: "No ledger", budget_usd: 10 });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /COSTS_ADMIN_TOKEN/);
    assert.equal(await db.document.count({ where: { parentDocumentId: provisioner.id } }), 0);

    await upsertDocumentEnv(provisioner.id, "COSTS_ADMIN_TOKEN", "ct_costs_token");
    await upsertDocumentEnv(provisioner.id, "COSTS_API_URL", fake.url);
    await upsertDocumentEnv(provisioner.id, "TINKER_API_KEY", "tml-shared-tinker");
    await upsertDocumentEnv(provisioner.id, "WORKSPACE_MAX_BUDGET_USD", "50");

    const tooMuch = await callTool(ctx, "create_workspace", { parent: provisioner.id, title: "Greedy", budget_usd: 51 });
    assert.equal(tooMuch.isError, true);
    assert.match(tooMuch.text, /exceeds this provisioner's cap of 50/);

    const created = await callTool(ctx, "create_workspace", { parent: provisioner.id, title: "Modest", budget_usd: 50 });
    assert.equal(created.isError, false, created.text);
    assert.deepEqual(created.json().budget.providers, { tinker: "shared" });
    assert.equal(created.json().budget.cost_project_parent, null);
    assert.equal(fake.calls("/key/generate").length, 0);

    // half-configured OpenWeights is refused before anything is created
    delete process.env.OPENWEIGHTS_SUPABASE_URL;
    await upsertDocumentEnv(provisioner.id, "OPENWEIGHTS_ADMIN_KEY", "ow_admin_secret");
    const before = fake.requests.length;
    const half = await callTool(ctx, "create_workspace", { parent: provisioner.id, title: "Half", budget_usd: 5 });
    assert.equal(half.isError, true);
    assert.match(half.text, /OPENWEIGHTS_SUPABASE_URL/);
    assert.equal(fake.requests.length, before, "no service was called");
  } finally {
    await fake.close();
  }
});

test("a workspace cannot give itself a budget or raise it; an existing workspace gets one from its parent", async () => {
  const fake = await startFakeProviders();
  try {
    const owner = await makeUser("budget-scope");
    const provisioner = await makeProvisioner(fake, owner.id);
    const child = await makeDoc(owner.id, "Existing child", provisioner.id);

    // a run confined to the child reaches neither its parent nor, therefore, a budget
    const confined = ctxFor(owner, { scopeDocumentId: child.id });
    const selfServe = await callTool(confined, "set_workspace_budget", { document: child.id, budget_usd: 999 });
    assert.equal(selfServe.isError, true);
    assert.match(selfServe.text, /may only access its own document/);

    // the owner (or a run of the provisioner) can
    const given = await callTool(ctxFor(owner, { scopeDocumentId: provisioner.id }), "set_workspace_budget", {
      document: child.id,
      budget_usd: 20
    });
    assert.equal(given.isError, false, given.text);
    assert.equal(given.json().budget.budget_usd, 20);

    const raise = await callTool(confined, "set_workspace_budget", { document: child.id, budget_usd: 999 });
    assert.equal(raise.isError, true);
    assert.equal(fake.projects.get(given.json().budget.cost_project)?.budget_usd, 20);
    // but it may look at its own budget
    const look = await callTool(confined, "get_workspace_budget", { document: child.id });
    assert.equal(look.isError, false, look.text);
    assert.equal(look.json().budget.budget_usd, 20);

    // a document-only run (third-party instructions) has no budget tools at all
    const documentOnly = ctxFor(owner, { scopeDocumentId: provisioner.id, toolset: "document-only" });
    assert.equal((await callTool(documentOnly, "set_workspace_budget", { document: child.id, budget_usd: 1 })).isError, true);

    const collaborator = await makeUser("budget-collab");
    await db.documentMembership.create({ data: { documentId: child.id, userId: collaborator.id, permission: "EDIT" } });
    const outsider = await callTool(ctxFor(collaborator), "set_workspace_budget", { document: child.id, budget_usd: 999 });
    assert.equal(outsider.isError, true, "edit on the workspace alone does not raise its budget");
  } finally {
    await fake.close();
  }
});

test("a used-up budget stops the workspace; raising it brings it back, and the LiteLLM key gets what the others left", async () => {
  const fake = await startFakeProviders(); // its dashboard always reports $61 spent: $43 Tinker, $18 LiteLLM
  try {
    assert.equal(liteLlmAllowance(100, { spent_usd: 61, by_provider: [{ provider: "tinker", usd: 43, estimated_usd: 0 }, { provider: "litellm", usd: 18, estimated_usd: 0 }] }), 57);
    assert.equal(liteLlmAllowance(30, { spent_usd: 61, by_provider: [{ provider: "tinker", usd: 43, estimated_usd: 0 }] }), 0);

    const owner = await makeUser("budget-enforce");
    const provisioner = await makeProvisioner(fake, owner.id);
    const ctx = ctxFor(owner);
    const created = (await callTool(ctx, "create_workspace", { parent: provisioner.id, title: "Small", budget_usd: 50 })).json();
    assert.equal((await loadDocumentEnv(created.id)).RDOCS_BROKER_TINKER, "1", "Tinker goes through the broker in a budgeted workspace");
    const run = await db.aiRun.create({
      data: { documentId: created.id, triggerType: "CONVERSATION", instruction: "t", status: "RUNNING" }
    });
    await assertWorkspaceBudgetAvailable(created.id);

    // $61 spent of $50
    const first = await enforceWorkspaceBudgets();
    assert.ok(first.exhausted.includes(created.budget.cost_project), JSON.stringify(first));
    assert.ok((await db.workspaceBudget.findUniqueOrThrow({ where: { documentId: created.id } })).exhaustedAt);
    assert.deepEqual(fake.calls("/key/block").at(-1)?.body, { key: "sk-minted-1" });
    assert.deepEqual(await runBudgetState(run.id), { costsProject: created.budget.cost_project, exhausted: true });
    await assert.rejects(assertWorkspaceBudgetAvailable(created.id), /budget \(\$50\) is used up/);
    const events = await db.aiRunEvent.findMany({ where: { aiRunId: run.id, role: "error" } });
    assert.match(events[0].message, /budget is used up \(\$61 spent, budget \$50\)/);
    // a second look changes nothing
    const blocks = fake.calls("/key/block").length;
    assert.deepEqual((await enforceWorkspaceBudgets()).exhausted, []);
    assert.equal(fake.calls("/key/block").length, blocks);

    // the provisioner raises it: the workspace runs again, the key may spend 1000 - 43
    const raised = await callTool(ctx, "set_workspace_budget", { document: created.id, budget_usd: 1000 });
    assert.equal(raised.isError, false, raised.text);
    assert.equal((await db.workspaceBudget.findUniqueOrThrow({ where: { documentId: created.id } })).exhaustedAt, null);
    assert.deepEqual(fake.calls("/key/unblock").at(-1)?.body, { key: "sk-minted-1" });
    assert.deepEqual(fake.calls("/key/update").at(-1)?.body, { key: "sk-minted-1", max_budget: 957 });
    await assertWorkspaceBudgetAvailable(created.id);
    assert.equal((await runBudgetState(run.id)).exhausted, false);

    // an unreachable dashboard is reported, and nobody is stopped because of it
    fake.fail.add("/spend");
    const down = await enforceWorkspaceBudgets();
    assert.ok(down.errors.some((error) => error.startsWith(created.budget.cost_project)));
    assert.equal((await db.workspaceBudget.findUniqueOrThrow({ where: { documentId: created.id } })).exhaustedAt, null);
  } finally {
    await fake.close();
  }
});
