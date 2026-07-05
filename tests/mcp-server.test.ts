import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createApiToken, resolveApiTokenUser, revokeApiToken } from "../lib/api-tokens";
import { getDocumentMarkdown, parseDocumentContent } from "../lib/content";
import { db } from "../lib/db";
import { handleMcpBody, handleMcpMessage, listMcpToolDefinitions } from "../lib/mcp/server";
import type { McpToolContext } from "../lib/mcp/tools";

const ORIGIN = "http://localhost:14141";

function docContent(paragraphs: string[]) {
  return JSON.stringify({
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }]
    }))
  });
}

async function makeUser(prefix: string) {
  return db.user.create({
    data: { email: `${prefix}-${crypto.randomUUID()}@example.com`, name: prefix, passwordHash: "x" }
  });
}

async function makeDoc(ownerId: string, paragraphs: string[], title = "MCP test doc") {
  return db.document.create({
    data: { title, content: docContent(paragraphs), ownerId }
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
  const result = response.result as { content: Array<{ type: string; text: string }>; isError: boolean };
  return result;
}

function parseToolJson(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

test("api tokens: create, resolve, revoke", async () => {
  const user = await makeUser("mcp-token");
  const { token, record } = await createApiToken(user.id, "laptop");

  assert.match(token, /^gdai_[0-9a-f]{48}$/);
  const resolved = await resolveApiTokenUser(`Bearer ${token}`);
  assert.equal(resolved?.id, user.id);

  assert.equal(await resolveApiTokenUser("Bearer gdai_nonsense"), null);
  assert.equal(await resolveApiTokenUser(undefined), null);
  assert.equal(await resolveApiTokenUser(`Basic ${token}`), null);

  assert.equal(await revokeApiToken(user.id, record.id), true);
  assert.equal(await resolveApiTokenUser(`Bearer ${token}`), null);
});

test("mcp handshake: initialize, tools/list, notifications", async () => {
  const user = await makeUser("mcp-shake");
  const ctx = ctxFor(user);

  const init = await handleMcpMessage(
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    ctx
  );
  assert.ok(init && "result" in init);
  const initResult = init.result as { protocolVersion: string; capabilities: { tools: object } };
  assert.equal(initResult.protocolVersion, "2025-03-26");
  assert.ok(initResult.capabilities.tools);

  // Unknown requested version → newest supported.
  const initFuture = await handleMcpMessage(
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2099-01-01" } },
    ctx
  );
  assert.equal((initFuture?.result as { protocolVersion: string }).protocolVersion, "2025-06-18");

  const tools = listMcpToolDefinitions();
  const names = tools.map((tool) => tool.name);
  for (const expected of [
    "list_documents",
    "read_document",
    "replace_in_document",
    "append_to_document",
    "replace_document",
    "create_document",
    "upload_files",
    "create_widget",
    "list_comments",
    "add_comment",
    "reply_to_comment"
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  for (const tool of tools) {
    assert.equal((tool.inputSchema as { type?: string }).type, "object", `${tool.name} schema must be an object`);
  }

  // Notifications get no response body (202 at the HTTP layer).
  const notified = await handleMcpBody({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx);
  assert.equal(notified.status, 202);
  assert.equal(notified.payload, null);

  const unknown = await handleMcpMessage({ jsonrpc: "2.0", id: 9, method: "no/such" }, ctx);
  assert.equal(unknown?.error?.code, -32601);
});

test("read_document returns markdown, widgets and threads; access is enforced", async () => {
  const owner = await makeUser("mcp-read-owner");
  const stranger = await makeUser("mcp-read-stranger");
  const doc = await makeDoc(owner.id, ["Alpha paragraph.", "Beta paragraph."]);
  const widget = await db.embeddedWidget.create({
    data: { documentId: doc.id, label: "Chart", buildCmd: "python widgets/build.py", embedSource: "assets/chart.html" }
  });

  const result = await callTool(ctxFor(owner), "read_document", {
    document: `${ORIGIN}/documents/${doc.id}`
  });
  assert.equal(result.isError, false);
  const payload = parseToolJson(result);
  assert.equal(payload.id, doc.id);
  assert.match(payload.markdown, /Alpha paragraph/);
  assert.equal(payload.widgets[0].widget_id, widget.id);
  assert.equal(payload.widgets[0].placeholder, `![widget: Chart](widget://${widget.id})`);

  const denied = await callTool(ctxFor(stranger), "read_document", { document: doc.id });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /not found or you do not have access/i);
});

test("replace_in_document edits through the collab pipeline", async () => {
  const owner = await makeUser("mcp-replace");
  const doc = await makeDoc(owner.id, ["Keep me intact.", "The old results were inconclusive.", "Tail stays."]);

  const result = await callTool(ctxFor(owner), "replace_in_document", {
    document: doc.id,
    find_text: "The old results were inconclusive.",
    replacement_markdown: "The rerun shows a **12%** improvement."
  });
  assert.equal(result.isError, false, result.content[0].text);

  const updated = await db.document.findUniqueOrThrow({ where: { id: doc.id }, select: { content: true } });
  const markdown = getDocumentMarkdown(parseDocumentContent(updated.content));
  assert.match(markdown, /rerun shows a \*\*12%\*\* improvement/);
  assert.match(markdown, /Keep me intact/);
  assert.match(markdown, /Tail stays/);
  assert.doesNotMatch(markdown, /inconclusive/);

  // Content changed via durable collaboration steps, not a direct write.
  const steps = await db.collaborationStep.count({ where: { documentId: doc.id } });
  assert.ok(steps > 0, "expected durable collaboration steps");

  // Ambiguous and missing find_text are tool-level errors the model can fix.
  const ambiguous = await callTool(ctxFor(owner), "replace_in_document", {
    document: doc.id,
    find_text: "e",
    replacement_markdown: "x"
  });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content[0].text, /matches \d+ places/);

  const missing = await callTool(ctxFor(owner), "replace_in_document", {
    document: doc.id,
    find_text: "text that certainly is not present",
    replacement_markdown: "x"
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /not found/);
});

test("replace with multi-block markdown and whitespace-normalized match", async () => {
  const owner = await makeUser("mcp-blocks");
  const doc = await makeDoc(owner.id, ["Intro.", "Results go here soon.", "Outro."]);

  const result = await callTool(ctxFor(owner), "replace_in_document", {
    document: doc.id,
    find_text: "Results   go here\nsoon.",
    replacement_markdown: "## Results\n\n| metric | value |\n| --- | --- |\n| loss | 0.12 |"
  });
  assert.equal(result.isError, false, result.content[0].text);

  const updated = await db.document.findUniqueOrThrow({ where: { id: doc.id }, select: { content: true } });
  const content = parseDocumentContent(updated.content) as { content: Array<{ type: string }> };
  const types = content.content.map((node) => node.type);
  assert.ok(types.includes("heading"), `expected a heading, got ${types.join(",")}`);
  assert.ok(types.includes("table"), `expected a table, got ${types.join(",")}`);
});

test("append_to_document resolves widget placeholders to embeddedWidget nodes", async () => {
  const owner = await makeUser("mcp-widget-append");
  const doc = await makeDoc(owner.id, ["Body."]);
  const widget = await db.embeddedWidget.create({
    data: { documentId: doc.id, label: "FFT", buildCmd: "python widgets/fft.py", embedSource: "assets/fft.html" }
  });

  const result = await callTool(ctxFor(owner), "append_to_document", {
    document: doc.id,
    markdown: `## Interactive\n\n![widget: FFT](widget://${widget.id})`
  });
  assert.equal(result.isError, false, result.content[0].text);

  const updated = await db.document.findUniqueOrThrow({ where: { id: doc.id }, select: { content: true } });
  const raw = updated.content;
  assert.match(raw, /"embeddedWidget"/);
  assert.match(raw, new RegExp(widget.id));
});

test("edit access is enforced for members with VIEW permission", async () => {
  const owner = await makeUser("mcp-perm-owner");
  const viewer = await makeUser("mcp-perm-viewer");
  const doc = await makeDoc(owner.id, ["Some text here."]);
  await db.documentMembership.create({
    data: { documentId: doc.id, userId: viewer.id, permission: "VIEW" }
  });

  const read = await callTool(ctxFor(viewer), "read_document", { document: doc.id });
  assert.equal(read.isError, false);

  const edit = await callTool(ctxFor(viewer), "replace_in_document", {
    document: doc.id,
    find_text: "Some text here.",
    replacement_markdown: "hijacked"
  });
  assert.equal(edit.isError, true);
  assert.match(edit.content[0].text, /edit access/);
});

test("comments: add_comment anchors a thread, reply_to_comment extends it", async () => {
  const owner = await makeUser("mcp-comment");
  const doc = await makeDoc(owner.id, ["The methodology section needs work."]);

  const added = await callTool(ctxFor(owner), "add_comment", {
    document: doc.id,
    find_text: "methodology section",
    body: "Should cite the 2025 baseline."
  });
  assert.equal(added.isError, false, added.content[0].text);
  const { thread_id } = parseToolJson(added);

  const thread = await db.commentThread.findUniqueOrThrow({
    where: { id: thread_id },
    include: { comments: true }
  });
  assert.equal(thread.anchorText, "methodology section");
  assert.equal(thread.createdById, owner.id);
  assert.equal(thread.comments.length, 1);
  assert.equal(thread.comments[0].authorId, owner.id);

  const replied = await callTool(ctxFor(owner), "reply_to_comment", {
    thread_id,
    body: "Done in the rerun."
  });
  assert.equal(replied.isError, false, replied.content[0].text);
  const comments = await db.comment.count({ where: { threadId: thread_id } });
  assert.equal(comments, 2);

  const badAnchor = await callTool(ctxFor(owner), "add_comment", {
    document: doc.id,
    find_text: "absent text",
    body: "x"
  });
  assert.equal(badAnchor.isError, true);
});

test("create_document seeds content; list_documents includes it", async () => {
  const owner = await makeUser("mcp-create");
  const created = await callTool(ctxFor(owner), "create_document", {
    title: "Fresh doc",
    markdown: "# Hello\n\nFrom MCP."
  });
  assert.equal(created.isError, false, created.content[0].text);
  const { id, url } = parseToolJson(created);
  assert.equal(url, `${ORIGIN}/documents/${id}`);

  const markdown = getDocumentMarkdown(
    parseDocumentContent((await db.document.findUniqueOrThrow({ where: { id } })).content)
  );
  assert.match(markdown, /# Hello/);

  const listed = await callTool(ctxFor(owner), "list_documents", {});
  const { documents } = parseToolJson(listed);
  assert.ok(documents.some((doc: { id: string }) => doc.id === id));
});

test("upload_files commits into the workspace; create_widget registers a widget", async () => {
  const owner = await makeUser("mcp-upload");
  const doc = await makeDoc(owner.id, ["Doc with workspace."]);
  const documentRoot = path.join(process.cwd(), ".research-workspaces", doc.id);

  try {
    const uploaded = await callTool(ctxFor(owner), "upload_files", {
      document: doc.id,
      files: [
        { path: "assets/data.csv", content: "x,y\n1,2\n" },
        { path: "assets/pixel.png", content_base64: Buffer.from([137, 80, 78, 71]).toString("base64") }
      ],
      message: "test upload"
    });
    assert.equal(uploaded.isError, false, uploaded.content[0].text);
    const uploadPayload = parseToolJson(uploaded);
    assert.ok(uploadPayload.commit_sha, "expected a commit sha");
    const workspace = path.join(documentRoot, "local");
    assert.ok(fs.existsSync(path.join(workspace, "assets/data.csv")));

    // Path traversal is rejected.
    const traversal = await callTool(ctxFor(owner), "upload_files", {
      document: doc.id,
      files: [{ path: "../escape.txt", content: "nope" }]
    });
    assert.equal(traversal.isError, true);
    assert.match(traversal.content[0].text, /escapes the workspace/);

    const widget = await callTool(ctxFor(owner), "create_widget", {
      document: doc.id,
      label: "Prebuilt",
      build_cmd: "python widgets/build.py",
      embed_source: "assets/widget.html",
      files: [
        { path: "widgets/build.py", content: "print('noop')\n" },
        { path: "assets/widget.html", content: "<!doctype html><p>hi</p>" }
      ],
      run_build: false
    });
    assert.equal(widget.isError, false, widget.content[0].text);
    const widgetPayload = parseToolJson(widget);
    assert.match(widgetPayload.placeholder, new RegExp(`widget://${widgetPayload.widget_id}`));

    const row = await db.embeddedWidget.findUniqueOrThrow({ where: { id: widgetPayload.widget_id } });
    assert.equal(row.documentId, doc.id);
    assert.equal(row.embedSource, "assets/widget.html");

    // A widget whose artifact does not exist is rejected.
    const broken = await callTool(ctxFor(owner), "create_widget", {
      document: doc.id,
      label: "Broken",
      build_cmd: "python widgets/missing.py",
      embed_source: "assets/missing.html",
      run_build: false
    });
    assert.equal(broken.isError, true);
    assert.match(broken.content[0].text, /does not exist/);
  } finally {
    fs.rmSync(documentRoot, { recursive: true, force: true });
  }
});
