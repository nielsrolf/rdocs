import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { handleMcpMessage } from "../lib/mcp/server";
import type { McpToolContext } from "../lib/mcp/tools";
import { createQuicktake, QUICKTAKE_KIND } from "../lib/quicktakes";

// Forum surfaces through MCP: an agent connected as a user must be able to READ
// that user's forum world — quicktakes (whose body lives in
// Document.quicktakeBody, NOT in the TipTap content) and documents shared with
// a group they belong to (a DocumentGroupAccess grant, not a membership row).
// Both used to be invisible/empty over MCP.

const ORIGIN = "http://localhost:14141";

async function makeUser(tag: string) {
  return db.user.create({
    data: { email: `mcpf-${tag}-${crypto.randomUUID()}@example.com`, name: tag, passwordHash: "x" }
  });
}

function ctxFor(user: { id: string; email: string; name: string }): McpToolContext {
  return { user: { id: user.id, email: user.email, name: user.name }, origin: ORIGIN };
}

async function callTool(ctx: McpToolContext, name: string, args: unknown) {
  const response = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    ctx
  );
  assert.ok(response && "result" in response, "tools/call must return a result");
  const result = response.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  return result;
}

async function callJson(ctx: McpToolContext, name: string, args: unknown) {
  const result = await callTool(ctx, name, args);
  assert.notEqual(result.isError, true, `tool ${name} failed: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

test("mcp read_document returns a quicktake's full body as markdown", async () => {
  const owner = await makeUser("qt-owner");
  const take = await createQuicktake(
    owner.id,
    "Persona vectors: steering on the *assistant* axis generalizes further than I expected. " +
      "Long enough that the document title truncates it."
  );

  try {
    const doc = await callJson(ctxFor(owner), "read_document", { document: take.id });
    assert.equal(doc.kind, QUICKTAKE_KIND);
    assert.match(doc.markdown, /Persona vectors/);
    assert.match(doc.markdown, /truncates it\./);
    assert.equal(doc.forum?.url, `${ORIGIN}/forum/quicktakes/${take.id}`);
  } finally {
    await db.document.deleteMany({ where: { id: take.id } });
    await db.user.deleteMany({ where: { id: owner.id } });
  }
});

test("mcp list_quicktakes returns the viewer's readable feed with bodies", async () => {
  const owner = await makeUser("qt-feed-owner");
  const other = await makeUser("qt-feed-other");
  const mine = await createQuicktake(owner.id, "My own take about steering vectors.");
  const theirs = await createQuicktake(other.id, "A public take from someone else.");

  try {
    const feed = await callJson(ctxFor(owner), "list_quicktakes", {});
    const byId = new Map<string, { body: string; is_owner: boolean }>(
      feed.quicktakes.map((q: { id: string; body: string; is_owner: boolean }) => [q.id, q])
    );
    assert.equal(byId.get(mine.id)?.body, "My own take about steering vectors.");
    assert.equal(byId.get(mine.id)?.is_owner, true);
    assert.equal(byId.get(theirs.id)?.body, "A public take from someone else.");
    assert.equal(byId.get(theirs.id)?.is_owner, false);
  } finally {
    await db.document.deleteMany({ where: { id: { in: [mine.id, theirs.id] } } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
  }
});

test("mcp list_documents includes documents shared with a group the user belongs to", async () => {
  const teamOwner = await makeUser("grp-owner");
  const member = await makeUser("grp-member");
  const group = await db.group.create({
    data: {
      name: `mcpf-group-${crypto.randomUUID().slice(0, 8)}`,
      ownerId: teamOwner.id,
      members: { create: [{ userId: member.id, role: "member" }] }
    }
  });
  const doc = await db.document.create({
    data: {
      title: "Team-only research note",
      content: JSON.stringify({ type: "doc", content: [] }),
      ownerId: teamOwner.id,
      forumPostedAt: new Date(),
      groupAccess: { create: { groupId: group.id, permission: "COMMENT" } }
    }
  });

  try {
    const listed = await callJson(ctxFor(member), "list_documents", {});
    const entry = listed.documents.find((d: { id: string }) => d.id === doc.id);
    assert.ok(entry, "group-shared document must be listed");
    assert.equal(entry.role, "comment");
  } finally {
    await db.document.deleteMany({ where: { id: doc.id } });
    await db.group.deleteMany({ where: { id: group.id } });
    await db.user.deleteMany({ where: { id: { in: [teamOwner.id, member.id] } } });
  }
});

test("mcp write tools refuse a quicktake instead of silently editing empty content", async () => {
  const owner = await makeUser("qt-write");
  const take = await createQuicktake(owner.id, "Original take body.");

  try {
    const result = await callTool(ctxFor(owner), "append_to_document", {
      document: take.id,
      markdown: "extra"
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /quicktake/i);
    const row = await db.document.findUnique({
      where: { id: take.id },
      select: { quicktakeBody: true }
    });
    assert.equal(row?.quicktakeBody, "Original take body.");
  } finally {
    await db.document.deleteMany({ where: { id: take.id } });
    await db.user.deleteMany({ where: { id: owner.id } });
  }
});
