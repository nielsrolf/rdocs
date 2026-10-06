import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import {
  createDocumentRunToken,
  DOCUMENT_BRIDGE_SERVER_NAME,
  verifyDocumentRunToken,
  withDocumentBridge
} from "../lib/document-run-token";
import { createChannelSchedule, listChannelSchedules } from "../lib/agent-channel-schedules";
import { createDocumentSchedule, DocumentScheduleError, fireDocumentTask, listDocumentSchedules } from "../lib/document-schedules";
import { handleMcpMessage, listMcpToolDefinitions } from "../lib/mcp/server";
import type { McpToolContext } from "../lib/mcp/tools";
import { createSlackToolsToken } from "../lib/slack/link-token";
import { fireScheduledTask } from "../lib/scheduler";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const ORIGIN = "http://localhost:14141";

async function fixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { email: `docsched-${suffix}@example.com`, name: "DocSched", passwordHash: "x" }
  });
  const content = JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Status: unknown" }] }]
  });
  const document = await db.document.create({ data: { title: `dash ${suffix}`, content, ownerId: user.id } });
  const other = await db.document.create({ data: { title: `other ${suffix}`, content, ownerId: user.id } });
  const cleanup = async () => {
    await db.document.deleteMany({ where: { id: { in: [document.id, other.id] } } }).catch(() => null);
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
  };
  return { user, document, other, cleanup };
}

function ctx(user: { id: string; email: string; name: string }, scopeDocumentId?: string): McpToolContext {
  return { user: { id: user.id, email: user.email, name: user.name }, origin: ORIGIN, scopeDocumentId };
}

async function call(c: McpToolContext, name: string, args: unknown) {
  const response = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    c
  );
  assert.ok(response && "result" in response);
  return response.result as { content: Array<{ text: string }>; isError: boolean };
}

test("document-run tokens round-trip and are not confused with Slack run tokens", async () => {
  const claims = { userId: "u1", documentId: "d1", aiRunId: "r1" };
  assert.deepEqual(await verifyDocumentRunToken(await createDocumentRunToken(claims)), claims);
  const slack = await createSlackToolsToken({ slackTeamId: "T", slackUserId: "U", aiRunId: "r1" });
  assert.equal(await verifyDocumentRunToken(slack), null);
  assert.equal(await verifyDocumentRunToken("garbage"), null);
});

test("withDocumentBridge mounts the bridge once and lets an integration's server of the same name win", async () => {
  const claims = { userId: "u1", documentId: "d1", aiRunId: "r1" };
  const servers = await withDocumentBridge([{ name: "fai", url: "http://x/mcp" }], claims);
  assert.deepEqual(servers.map((s) => s.name), ["fai", DOCUMENT_BRIDGE_SERVER_NAME]);
  const bridge = servers[1];
  const token = bridge.headers!.Authorization.replace(/^Bearer /, "");
  assert.deepEqual(await verifyDocumentRunToken(token), claims);

  const custom = [{ name: DOCUMENT_BRIDGE_SERVER_NAME, url: "http://custom/mcp" }];
  assert.deepEqual(await withDocumentBridge(custom, claims), custom);
});

test("a document-scoped MCP caller is confined to its document", async (t) => {
  const { user, document, other, cleanup } = await fixture();
  t.after(cleanup);
  const scoped = ctx(user, document.id);

  const names = listMcpToolDefinitions(scoped).map((tool) => tool.name);
  assert.ok(names.includes("replace_in_document"));
  assert.ok(names.includes("schedule_task"));
  for (const hidden of ["list_documents", "list_quicktakes", "create_document"]) {
    assert.ok(!names.includes(hidden), `${hidden} must be hidden`);
    assert.ok(listMcpToolDefinitions().some((tool) => tool.name === hidden), `${hidden} stays for normal callers`);
  }

  const own = await call(scoped, "replace_in_document", {
    document: document.id,
    find_text: "Status: unknown",
    replacement_markdown: "Status: on track"
  });
  assert.equal(own.isError, false, own.content[0].text);
  const read = await call(scoped, "read_document", { document: `${ORIGIN}/documents/${document.id}` });
  assert.match(read.content[0].text, /on track/);

  const foreign = await call(scoped, "read_document", { document: other.id });
  assert.equal(foreign.isError, true);
  assert.match(foreign.content[0].text, /only access its own document/);

  const roaming = await call(scoped, "list_documents", {});
  assert.equal(roaming.isError, true);

  // the same user without a scope still reaches both documents
  assert.equal((await call(ctx(user), "read_document", { document: other.id })).isError, false);
});

test("schedule_task / list_scheduled_tasks / cancel_scheduled_task over MCP", async (t) => {
  const { user, document, cleanup } = await fixture();
  const stranger = await db.user.create({
    data: { email: `stranger-${crypto.randomUUID()}@example.com`, name: "Stranger", passwordHash: "x" }
  });
  t.after(async () => {
    await cleanup();
    await db.user.delete({ where: { id: stranger.id } }).catch(() => null);
  });

  const tooFrequent = await call(ctx(user), "schedule_task", {
    document: document.id, instruction: "refresh", cron: "* * * * *"
  });
  assert.equal(tooFrequent.isError, true);

  const denied = await call(ctx(stranger), "schedule_task", {
    document: document.id, instruction: "refresh", cron: "0 7 * * *"
  });
  assert.equal(denied.isError, true);

  const created = await call(ctx(user), "schedule_task", {
    document: document.id, instruction: "Refresh the dashboard.", cron: "30 7 * * *", timezone: "Europe/Berlin"
  });
  assert.equal(created.isError, false, created.content[0].text);
  const taskId = JSON.parse(created.content[0].text).scheduled.id as string;

  const listed = JSON.parse((await call(ctx(user), "list_scheduled_tasks", { document: document.id })).content[0].text);
  assert.deepEqual(listed.tasks.map((task: { id: string }) => task.id), [taskId]);

  const cancelled = await call(ctx(user), "cancel_scheduled_task", { document: document.id, task_id: taskId });
  assert.equal(cancelled.isError, false);
  assert.deepEqual(await listDocumentSchedules(document.id), []);
  assert.equal((await call(ctx(user), "cancel_scheduled_task", { document: document.id, task_id: taskId })).isError, true);
});

test("a document task fires as a headless SCHEDULED run with the bridge mounted", async (t) => {
  const { user, document, cleanup } = await fixture();
  t.after(cleanup);

  await assert.rejects(
    createDocumentSchedule({ documentId: document.id, createdById: user.id, instruction: "  " , cron: "0 7 * * *" }),
    DocumentScheduleError
  );
  const schedule = await createDocumentSchedule({
    documentId: document.id,
    createdById: user.id,
    instruction: "Refresh the dashboard.",
    cron: "0 7 * * *"
  });
  const task = await db.scheduledTask.findUniqueOrThrow({ where: { id: schedule.id } });

  const calls: Array<{ message: string; mcpServers?: Array<{ name: string; headers?: Record<string, string> }> }> = [];
  const runId = await fireScheduledTask(task, undefined, {
    runInBackground: async (input) => {
      calls.push({ message: input.message, mcpServers: input.mcpServers });
    }
  });
  assert.ok(runId);
  const run = await db.aiRun.findUniqueOrThrow({ where: { id: runId! } });
  assert.equal(run.triggerType, "SCHEDULED");
  assert.equal(run.triggerId, `schedule:${schedule.id}`);
  assert.equal(run.createdById, user.id);
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /Headless run/);
  assert.match(calls[0].message, /Refresh the dashboard\./);
  const bridge = calls[0].mcpServers?.find((server) => server.name === DOCUMENT_BRIDGE_SERVER_NAME);
  assert.ok(bridge);
  const claims = await verifyDocumentRunToken(bridge!.headers!.Authorization.replace(/^Bearer /, ""));
  assert.deepEqual(claims, { userId: user.id, documentId: document.id, aiRunId: runId });
  assert.equal((await listDocumentSchedules(document.id))[0].lastRunId, runId);
});

test("a document task whose scheduler lost edit access is disabled, not fired", async (t) => {
  const { user, document, cleanup } = await fixture();
  const editor = await db.user.create({
    data: { email: `editor-${crypto.randomUUID()}@example.com`, name: "Editor", passwordHash: "x" }
  });
  t.after(async () => {
    await cleanup();
    await db.user.delete({ where: { id: editor.id } }).catch(() => null);
  });
  // A task created by someone who never had access (e.g. removed collaborator).
  const schedule = await createDocumentSchedule({
    documentId: document.id,
    createdById: editor.id,
    instruction: "Refresh.",
    cron: "0 7 * * *"
  });
  const fired = await fireDocumentTask(await db.scheduledTask.findUniqueOrThrow({ where: { id: schedule.id } }), {
    runInBackground: async () => {
      throw new Error("must not start");
    }
  });
  assert.equal(fired, null);
  assert.deepEqual(await listDocumentSchedules(document.id), []);
  void user;
});

test("list_scheduled_tasks also shows the document's API-channel jobs, and can cancel them", async (t) => {
  const { user, document, cleanup } = await fixture();
  t.after(cleanup);
  const channelJob = await createChannelSchedule({
    documentId: document.id,
    createdById: user.id,
    instruction: "Update this dashboard.",
    cron: "0 7 * * *"
  });
  const scoped = ctx(user, document.id);
  const listed = JSON.parse((await call(scoped, "list_scheduled_tasks", { document: document.id })).content[0].text);
  assert.deepEqual(
    listed.tasks.map((task: { id: string; context: string }) => [task.id, task.context]),
    [[channelJob.id, "api_channel"]]
  );
  const cancelled = await call(scoped, "cancel_scheduled_task", { document: document.id, task_id: channelJob.id });
  assert.equal(cancelled.isError, false, cancelled.content[0].text);
  assert.deepEqual(await listChannelSchedules(document.id), []);
});
