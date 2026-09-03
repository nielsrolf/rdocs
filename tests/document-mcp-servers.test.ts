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
import {
  McpServerValidationError,
  deleteDocumentMcpServer,
  listDocumentMcpServers,
  loadDocumentMcpServerInputs,
  resolveMcpServerInputs,
  upsertDocumentMcpServer
} from "../lib/document-mcp-servers";

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
