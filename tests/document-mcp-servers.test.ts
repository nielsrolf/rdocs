import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  claudeMcpServerOptions,
  codexMcpServerOptions,
  mcpServerAllowedTools
} from "../agent-core/mcp-servers";
import { codexProviderConfig } from "../agent-core/codex-agent";
import { resolveChannelPreviousRunId, upsertAgentApiChannel } from "../lib/agent-api-channels";
import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";
import { channelRunMcpServers, channelRunMessageSchema } from "../lib/agent-channel-runs";
import { upsertDocumentEnv } from "../lib/document-env";
import {
  McpServerValidationError,
  deleteDocumentMcpServer,
  deleteUserMcpServer,
  listDocumentMcpServers,
  listInheritedMcpServers,
  listUserMcpServers,
  loadDocumentMcpServerInputs,
  loadRunMcpServerInputs,
  mergeMcpServerInputs,
  resolveMcpServerInputs,
  resolveRunMcpServerInputs,
  upsertDocumentMcpServer,
  upsertUserMcpServer
} from "../lib/document-mcp-servers";

process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || crypto.randomBytes(32).toString("base64");

async function fixture() {
  const user = await db.user.create({
    data: { email: `mcp-${crypto.randomUUID()}@example.com`, name: "MCP", passwordHash: "x" }
  });
  const document = await db.document.create({
    data: {
      ownerId: user.id,
      title: "MCP servers",
      content: serializeDocumentContent({ type: "doc", content: [{ type: "paragraph" }] })
    }
  });
  return { user, document };
}

test("resolveMcpServerInputs fills bearer headers from the env and skips servers whose key is missing", () => {
  const warnings: string[] = [];
  const resolved = resolveMcpServerInputs(
    [
      { name: "fai", url: "http://host.docker.internal:14160/mcp", authEnvKey: "FAI_TOKEN" },
      { name: "public", url: "https://example.com/mcp", authEnvKey: null },
      { name: "orphan", url: "https://example.com/mcp", authEnvKey: "MISSING" }
    ],
    { FAI_TOKEN: "fai_user_abc" },
    (message) => warnings.push(message)
  );
  assert.deepEqual(resolved, [
    { name: "fai", url: "http://host.docker.internal:14160/mcp", headers: { Authorization: "Bearer fai_user_abc" } },
    { name: "public", url: "https://example.com/mcp" }
  ]);
  assert.equal(warnings.length, 1);

  assert.deepEqual(claudeMcpServerOptions(resolved), {
    fai: { type: "http", url: "http://host.docker.internal:14160/mcp", headers: { Authorization: "Bearer fai_user_abc" } },
    public: { type: "http", url: "https://example.com/mcp" }
  });
  assert.deepEqual(mcpServerAllowedTools(resolved), ["mcp__fai", "mcp__public"]);
  // A reserved name can never replace the built-in servers.
  assert.deepEqual(claudeMcpServerOptions([{ name: "gdocs", url: "https://evil.example/mcp" }]), {});
  assert.deepEqual(codexMcpServerOptions(resolved).fai, {
    url: "http://host.docker.internal:14160/mcp",
    http_headers: { Authorization: "Bearer fai_user_abc" },
    required: false
  });
});

test("codexProviderConfig mounts document MCP servers with and without slackTools", () => {
  const servers = [{ name: "fai", url: "https://f.example/mcp", headers: { Authorization: "Bearer t" } }];
  const withoutSlack = codexProviderConfig("openai", { OPENAI_API_KEY: "sk-test" }, { mcpServers: servers });
  const mcp = withoutSlack.config.mcp_servers as Record<string, { url: string }>;
  assert.equal(mcp.fai.url, "https://f.example/mcp");
  assert.equal(mcp.gdocs, undefined);

  const withSlack = codexProviderConfig("openai", { OPENAI_API_KEY: "sk-test" }, {
    mcpServers: servers,
    slackTools: { url: "https://r.example/api/agent-tools", token: "run-token" }
  });
  const both = withSlack.config.mcp_servers as Record<string, { url: string }>;
  assert.equal(both.fai.url, "https://f.example/mcp");
  assert.equal(both.gdocs.url, "https://r.example/api/agent-tools");
});

test("document MCP servers are validated, stored per document and resolved against the env", async () => {
  const { user, document } = await fixture();
  try {
    await assert.rejects(
      upsertDocumentMcpServer({ documentId: document.id, name: "gdocs", url: "https://x.example/mcp" }),
      McpServerValidationError
    );
    await assert.rejects(
      upsertDocumentMcpServer({ documentId: document.id, name: "fai", url: "ftp://x.example/mcp" }),
      McpServerValidationError
    );
    await assert.rejects(
      upsertDocumentMcpServer({ documentId: document.id, name: "fai", url: "https://x.example/mcp", authEnvKey: "bad key" }),
      McpServerValidationError
    );

    let servers = await upsertDocumentMcpServer({
      documentId: document.id,
      name: "fai",
      url: "https://x.example/mcp",
      authEnvKey: "FAI_TOKEN"
    });
    assert.equal(servers.length, 1);
    // Same name replaces instead of duplicating.
    servers = await upsertDocumentMcpServer({ documentId: document.id, name: "fai", url: "https://y.example/mcp" });
    assert.equal(servers.length, 1);
    assert.equal(servers[0].url, "https://y.example/mcp");
    assert.equal(servers[0].authEnvKey, null);

    assert.deepEqual(await loadDocumentMcpServerInputs(document.id, {}), [{ name: "fai", url: "https://y.example/mcp" }]);

    servers = await deleteDocumentMcpServer(document.id, "fai");
    assert.equal(servers.length, 0);
    assert.deepEqual(await listDocumentMcpServers(document.id), []);
  } finally {
    await db.document.delete({ where: { id: document.id } }).catch(() => null);
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
  }
});

test("channel follow-ups may only resume runs of the same channel", async () => {
  const { user, document } = await fixture();
  const other = await fixture();
  try {
    const { channel } = await upsertAgentApiChannel({ documentId: document.id, createdById: user.id, label: null });
    const foreignChannel = await upsertAgentApiChannel({
      documentId: other.document.id,
      createdById: other.user.id,
      label: null
    });
    const ownRun = await db.aiRun.create({
      data: {
        documentId: document.id,
        triggerType: "API",
        triggerId: channel.id,
        createdById: user.id,
        instruction: "hi",
        status: "COMPLETED",
        suggestOnly: true
      }
    });
    const foreignRun = await db.aiRun.create({
      data: {
        documentId: other.document.id,
        triggerType: "API",
        triggerId: foreignChannel.channel.id,
        createdById: other.user.id,
        instruction: "hi",
        status: "COMPLETED",
        suggestOnly: true
      }
    });
    const docRun = await db.aiRun.create({
      data: { documentId: document.id, triggerType: "CONVERSATION", createdById: user.id, instruction: "hi", status: "COMPLETED" }
    });

    assert.equal(await resolveChannelPreviousRunId(channel, null), null);
    assert.equal(await resolveChannelPreviousRunId(channel, ownRun.id), ownRun.id);
    assert.equal(await resolveChannelPreviousRunId(channel, foreignRun.id), undefined);
    assert.equal(await resolveChannelPreviousRunId(channel, docRun.id), undefined);
    assert.equal(await resolveChannelPreviousRunId(channel, "nope"), undefined);
  } finally {
    for (const doc of [document, other.document]) await db.document.delete({ where: { id: doc.id } }).catch(() => null);
    for (const u of [user, other.user]) await db.user.delete({ where: { id: u.id } }).catch(() => null);
  }
});

test("mergeMcpServerInputs: run > document > workspace > user on a name clash, order otherwise preserved", () => {
  const merged = mergeMcpServerInputs({
    user: [{ name: "shared", url: "https://user.example/mcp" }, { name: "mine", url: "https://mine.example/mcp" }],
    workspace: [{ name: "shared", url: "https://ws.example/mcp" }, { name: "ws", url: "https://ws2.example/mcp" }],
    document: [{ name: "shared", url: "https://doc.example/mcp" }],
    run: [{ name: "ws", url: "https://run.example/mcp", headers: { Authorization: "Bearer r" } }]
  });
  assert.deepEqual(merged, [
    { name: "ws", url: "https://run.example/mcp", headers: { Authorization: "Bearer r" } },
    { name: "shared", url: "https://doc.example/mcp" },
    { name: "mine", url: "https://mine.example/mcp" }
  ]);
});

test("per-run servers from the agent API are validated and turned into bearer/explicit headers", () => {
  assert.deepEqual(
    resolveRunMcpServerInputs([
      { name: "a", url: "https://a.example/mcp", authToken: "tok" },
      { name: "b", url: "https://b.example/mcp", headers: { "X-Api-Key": "k" } },
      { name: "c", url: "https://c.example/mcp" }
    ]),
    [
      { name: "a", url: "https://a.example/mcp", headers: { Authorization: "Bearer tok" } },
      { name: "b", url: "https://b.example/mcp", headers: { "X-Api-Key": "k" } },
      { name: "c", url: "https://c.example/mcp" }
    ]
  );
  assert.deepEqual(resolveRunMcpServerInputs(undefined), []);
  assert.throws(() => resolveRunMcpServerInputs([{ name: "rdocs", url: "https://x.example/mcp" }]), McpServerValidationError);
  assert.throws(
    () => resolveRunMcpServerInputs([{ name: "a", url: "https://x.example/mcp" }, { name: "a", url: "https://y.example/mcp" }]),
    McpServerValidationError
  );
  assert.throws(
    () => resolveRunMcpServerInputs([{ name: "a", url: "https://x.example/mcp", headers: { "Bad Header": "v" } }]),
    McpServerValidationError
  );
  assert.throws(
    () => resolveRunMcpServerInputs([{ name: "a", url: "https://x.example/mcp", headers: { "X-H": "v\r\nInjected: 1" } }]),
    McpServerValidationError
  );

  // The HTTP body schema accepts the same shape and the route helper is the same validator.
  const parsed = channelRunMessageSchema.safeParse({
    message: "hi",
    mcpServers: [{ name: "a", url: "https://a.example/mcp", authToken: "tok" }]
  });
  assert.ok(parsed.success);
  assert.deepEqual(channelRunMcpServers(parsed.success ? parsed.data.mcpServers : null), [
    { name: "a", url: "https://a.example/mcp", headers: { Authorization: "Bearer tok" } }
  ]);
  assert.equal(channelRunMessageSchema.safeParse({ message: "hi", mcpServers: [{ name: "a" }] }).success, false);
});

test("user-scoped servers: token is stored encrypted, never listed, and applies to every run the user triggers", async () => {
  const { user, document } = await fixture();
  try {
    await assert.rejects(
      upsertUserMcpServer({ userId: user.id, name: "gdocs", url: "https://x.example/mcp" }),
      McpServerValidationError
    );
    let servers = await upsertUserMcpServer({ userId: user.id, name: "mine", url: "https://mine.example/mcp", authToken: "secret-1" });
    assert.equal(servers.length, 1);
    assert.equal(servers[0].hasAuthToken, true);
    assert.equal("authToken" in servers[0], false);
    const row = await db.userMcpServer.findFirstOrThrow({ where: { userId: user.id, name: "mine" } });
    assert.notEqual(row.authToken, "secret-1");
    assert.equal(row.authToken?.includes("secret-1"), false);

    // Re-saving without a token keeps the stored one; null clears it.
    servers = await upsertUserMcpServer({ userId: user.id, name: "mine", url: "https://mine2.example/mcp" });
    assert.equal(servers[0].url, "https://mine2.example/mcp");
    assert.equal(servers[0].hasAuthToken, true);

    let resolved = await loadRunMcpServerInputs({ documentId: document.id, userId: user.id, env: {} });
    assert.deepEqual(resolved, [
      { name: "mine", url: "https://mine2.example/mcp", headers: { Authorization: "Bearer secret-1" } }
    ]);
    // Anonymous runs (no triggering user) get no personal servers.
    assert.deepEqual(await loadRunMcpServerInputs({ documentId: document.id, userId: null, env: {} }), []);

    servers = await upsertUserMcpServer({ userId: user.id, name: "mine", url: "https://mine2.example/mcp", authToken: null });
    assert.equal(servers[0].hasAuthToken, false);
    resolved = await loadRunMcpServerInputs({ documentId: document.id, userId: user.id, env: {} });
    assert.deepEqual(resolved, [{ name: "mine", url: "https://mine2.example/mcp" }]);

    // A document server of the same name overrides the personal one.
    await upsertDocumentMcpServer({ documentId: document.id, name: "mine", url: "https://doc.example/mcp" });
    resolved = await loadRunMcpServerInputs({ documentId: document.id, userId: user.id, env: {} });
    assert.deepEqual(resolved, [{ name: "mine", url: "https://doc.example/mcp" }]);
    const inherited = await listInheritedMcpServers(document.id, user.id);
    assert.deepEqual(inherited, [{ name: "mine", url: "https://mine2.example/mcp", scope: "user", shadowed: true }]);

    // And a per-run server overrides the document one.
    resolved = await loadRunMcpServerInputs({
      documentId: document.id,
      userId: user.id,
      env: {},
      runServers: [{ name: "mine", url: "https://run.example/mcp" }]
    });
    assert.deepEqual(resolved, [{ name: "mine", url: "https://run.example/mcp" }]);

    servers = await deleteUserMcpServer(user.id, "mine");
    assert.deepEqual(servers, []);
    assert.deepEqual(await listUserMcpServers(user.id), []);
  } finally {
    await db.document.delete({ where: { id: document.id } }).catch(() => null);
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
  }
});

test("workspace-scoped servers: a document sharing another document's workspace inherits its servers and their env keys", async () => {
  const { user, document: workspaceDoc } = await fixture();
  const member = await db.document.create({
    data: {
      ownerId: user.id,
      title: "member",
      content: serializeDocumentContent({ type: "doc", content: [{ type: "paragraph" }] }),
      workspaceDocumentId: workspaceDoc.id
    }
  });
  try {
    await upsertDocumentMcpServer({ documentId: workspaceDoc.id, name: "ws", url: "https://ws.example/mcp", authEnvKey: "WS_TOKEN" });
    await upsertDocumentMcpServer({ documentId: workspaceDoc.id, name: "shared", url: "https://ws-shared.example/mcp" });
    await upsertDocumentMcpServer({ documentId: member.id, name: "shared", url: "https://member.example/mcp" });
    // The operator put the key on the workspace document, not on the member.
    await upsertDocumentEnv(workspaceDoc.id, "WS_TOKEN", "ws-secret");

    const resolved = await loadRunMcpServerInputs({ documentId: member.id, userId: user.id, env: {} });
    assert.deepEqual(resolved, [
      { name: "shared", url: "https://member.example/mcp" },
      { name: "ws", url: "https://ws.example/mcp", headers: { Authorization: "Bearer ws-secret" } }
    ]);
    // The run env (member document env + account keys) still wins for the same key.
    const overridden = await loadRunMcpServerInputs({ documentId: member.id, userId: user.id, env: { WS_TOKEN: "member-secret" } });
    assert.equal(overridden[1].headers?.Authorization, "Bearer member-secret");

    assert.deepEqual(await listInheritedMcpServers(member.id, user.id), [
      { name: "ws", url: "https://ws.example/mcp", scope: "workspace", shadowed: false },
      { name: "shared", url: "https://ws-shared.example/mcp", scope: "workspace", shadowed: true }
    ]);
    // The workspace-owning document itself inherits nothing.
    assert.deepEqual(await listInheritedMcpServers(workspaceDoc.id, null), []);
  } finally {
    await db.document.delete({ where: { id: member.id } }).catch(() => null);
    await db.document.delete({ where: { id: workspaceDoc.id } }).catch(() => null);
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
  }
});
