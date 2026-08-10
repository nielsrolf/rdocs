// Boot adoption of orphaned detached session containers.
//
// A detached container is nobody's child: after a deploy (or a crash) the run is
// still working, but no process is reading its frames. The four persisted
// columns — containerId / sessionEndpoint / sessionSecret / frameCursor — are the
// entire handover surface, so a fresh process must be able to pick the run up,
// replay only what it has not persisted, and finalize it.
//
// "The container" here is a REAL in-process session server (as in
// agent-session-host.test.ts); the DB is the real SQLite one (as in
// agent-session-reaper.test.ts). No Docker, no LLM.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createAgentSessionState, type AgentSessionFrameBody } from "../agent-core/session-protocol";
import { createAgentSessionServer } from "../agent-core/session-server";
import { adoptOrphanedSessions } from "../lib/agent-runner/session-adoption";
import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";

const SECRET = "container-secret";

type FakeContainer = {
  endpoint: string;
  emit: (frame: AgentSessionFrameBody) => void;
  close: () => Promise<void>;
  jobs: unknown[];
  exits: string[];
};

async function startFakeContainer(): Promise<FakeContainer> {
  const state = createAgentSessionState();
  const container: FakeContainer = {
    endpoint: "",
    emit: () => {},
    close: async () => {},
    jobs: [],
    exits: []
  };
  const server = createAgentSessionServer({
    state,
    secret: SECRET,
    sweepIntervalMs: 0,
    handlers: {
      onJob: (job) => void container.jobs.push(job),
      onMessage: () => true,
      onCancel: () => {},
      onExit: (reason) => void container.exits.push(reason)
    }
  });
  const port = await server.listen(0, "127.0.0.1");
  container.endpoint = `http://127.0.0.1:${port}`;
  container.emit = (frame) => server.emit(frame);
  container.close = () => server.close();
  return container;
}

function content() {
  return serializeDocumentContent({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "orphaned run document" }] }]
  });
}

async function makeDoc(label: string) {
  const user = await db.user.create({
    data: {
      email: `session-adoption-${label}-${crypto.randomUUID()}@example.com`,
      name: label,
      passwordHash: "x"
    }
  });
  const document = await db.document.create({
    data: { title: "Session adoption test", content: content(), ownerId: user.id }
  });
  return { user, document };
}

async function makeOrphan(options: {
  documentId: string;
  createdById: string;
  endpoint: string | null;
  frameCursor?: number;
  triggerType?: string;
  triggerId?: string | null;
}) {
  return db.aiRun.create({
    data: {
      documentId: options.documentId,
      createdById: options.createdById,
      triggerType: options.triggerType ?? "CONVERSATION",
      triggerId: options.triggerId ?? null,
      instruction: "orphaned detached run",
      status: "RUNNING",
      startedAt: new Date(Date.now() - 60_000),
      heartbeatAt: new Date(Date.now() - 60_000),
      containerId: "abcdef012345",
      sessionEndpoint: options.endpoint,
      sessionSecret: options.endpoint ? SECRET : null,
      frameCursor: options.frameCursor ?? 0
    }
  });
}

async function cleanup(documentId: string, userId: string) {
  await db.aiRun.updateMany({ where: { documentId }, data: { status: "FAILED", sessionEndpoint: null } });
  await db.document.delete({ where: { id: documentId } }).catch(() => null);
  await db.user.delete({ where: { id: userId } }).catch(() => null);
}

async function eventMessages(aiRunId: string) {
  const events = await db.aiRunEvent.findMany({
    where: { aiRunId },
    orderBy: { createdAt: "asc" },
    select: { role: true, message: true }
  });
  return events.map((event) => `${event.role}: ${event.message}`);
}

test("an orphaned conversation run whose container answers is adopted and finalized", async () => {
  const { user, document } = await makeDoc("adopt");
  const container = await startFakeContainer();
  try {
    const run = await makeOrphan({ documentId: document.id, createdById: user.id, endpoint: container.endpoint });
    container.emit({ type: "progress", event: { role: "agent", message: "still working" } });
    container.emit({ type: "result", output: { reply: "picked up where I left off", summary: "done" } });

    const result = await adoptOrphanedSessions({ runIds: [run.id], waitMs: 200 });
    assert.deepEqual(result.adopted, [run.id]);
    await result.settled;

    const fresh = await db.aiRun.findUnique({
      where: { id: run.id },
      select: { status: true, progress: true, sessionEndpoint: true, sessionSecret: true, frameCursor: true }
    });
    assert.equal(fresh?.status, "SUCCEEDED");
    assert.equal(fresh?.sessionEndpoint, null, "a released container must stop being advertised");
    assert.equal(fresh?.sessionSecret, null);
    assert.equal(fresh?.frameCursor, 2, "the cursor must reach the terminal frame");

    const messages = await eventMessages(run.id);
    // Never adopt silently.
    assert.ok(
      messages.some((message) => message.startsWith("system:") && /adopted/i.test(message)),
      messages.join("\n")
    );
    assert.equal(messages.filter((message) => message.includes("still working")).length, 1);
    assert.ok(messages.some((message) => message === "agent: picked up where I left off"));

    // Released only after the outcome was persisted.
    for (let i = 0; i < 50 && container.exits.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(container.exits, ["released"]);
    assert.deepEqual(container.jobs, [], "adoption must never start a second agent turn");
  } finally {
    await container.close();
    await cleanup(document.id, user.id);
  }
});

test("frames at or below the persisted cursor are not replayed", async () => {
  const { user, document } = await makeDoc("cursor");
  const container = await startFakeContainer();
  try {
    const run = await makeOrphan({
      documentId: document.id,
      createdById: user.id,
      endpoint: container.endpoint,
      frameCursor: 2
    });
    container.emit({ type: "progress", event: { role: "agent", message: "already persisted one" } });
    container.emit({ type: "progress", event: { role: "agent", message: "already persisted two" } });
    container.emit({ type: "progress", event: { role: "agent", message: "brand new" } });
    container.emit({ type: "result", output: { reply: "ok" } });

    const result = await adoptOrphanedSessions({ runIds: [run.id], waitMs: 200 });
    await result.settled;

    const messages = await eventMessages(run.id);
    assert.equal(messages.filter((message) => message.includes("already persisted")).length, 0);
    assert.equal(messages.filter((message) => message.includes("brand new")).length, 1);
  } finally {
    await container.close();
    await cleanup(document.id, user.id);
  }
});

test("an unreachable session is left untouched for the reaper", async () => {
  const { user, document } = await makeDoc("dead");
  try {
    const run = await makeOrphan({
      documentId: document.id,
      createdById: user.id,
      endpoint: "http://127.0.0.1:1"
    });

    const result = await adoptOrphanedSessions({ runIds: [run.id], probe: async () => false });
    await result.settled;

    assert.deepEqual(result.adopted, []);
    assert.equal(result.skipped.find((entry) => entry.aiRunId === run.id)?.reason, "unreachable");
    const fresh = await db.aiRun.findUnique({
      where: { id: run.id },
      select: { status: true, sessionEndpoint: true }
    });
    assert.equal(fresh?.status, "RUNNING", "reaping stays the reaper's job");
    assert.equal(fresh?.sessionEndpoint, "http://127.0.0.1:1");
    assert.deepEqual(await eventMessages(run.id), []);
  } finally {
    await cleanup(document.id, user.id);
  }
});

test("a non-conversation trigger type is not finalized by adoption", async () => {
  const { user, document } = await makeDoc("selection");
  const container = await startFakeContainer();
  try {
    const run = await makeOrphan({
      documentId: document.id,
      createdById: user.id,
      endpoint: container.endpoint,
      triggerType: "SELECTION_EDIT"
    });

    const result = await adoptOrphanedSessions({ runIds: [run.id], waitMs: 200 });
    await result.settled;

    assert.deepEqual(result.adopted, []);
    assert.equal(result.skipped.find((entry) => entry.aiRunId === run.id)?.reason, "unsupported-trigger");
    const fresh = await db.aiRun.findUnique({ where: { id: run.id }, select: { status: true } });
    assert.equal(fresh?.status, "RUNNING");
    assert.deepEqual(await eventMessages(run.id), []);
  } finally {
    await container.close();
    await cleanup(document.id, user.id);
  }
});

test("a run already being adopted in this process is not adopted twice", async () => {
  const { user, document } = await makeDoc("twice");
  const container = await startFakeContainer();
  try {
    const run = await makeOrphan({ documentId: document.id, createdById: user.id, endpoint: container.endpoint });

    const first = await adoptOrphanedSessions({ runIds: [run.id], waitMs: 200 });
    assert.deepEqual(first.adopted, [run.id]);

    const second = await adoptOrphanedSessions({ runIds: [run.id], waitMs: 200 });
    assert.deepEqual(second.adopted, [], "a second sweep must not race the first reader");
    assert.equal(second.skipped.find((entry) => entry.aiRunId === run.id)?.reason, "in-flight");

    container.emit({ type: "result", output: { reply: "single reader" } });
    await first.settled;
    await second.settled;

    const messages = await eventMessages(run.id);
    assert.equal(messages.filter((message) => message === "agent: single reader").length, 1);
  } finally {
    await container.close();
    await cleanup(document.id, user.id);
  }
});

test("an adopted Slack run's reply is delivered from the persisted trigger id", async () => {
  const { user, document } = await makeDoc("slack");
  const container = await startFakeContainer();
  const delivered: Array<{ channel: string; threadTs: string; text: string }> = [];
  try {
    const run = await makeOrphan({
      documentId: document.id,
      createdById: user.id,
      endpoint: container.endpoint,
      triggerType: "SLACK_MENTION",
      triggerId: "C123:1700000000.000100"
    });
    container.emit({ type: "result", output: { reply: "slack answer" } });

    const result = await adoptOrphanedSessions({
      runIds: [run.id],
      waitMs: 200,
      deliverSlackReply: async (args) => void delivered.push(args)
    });
    await result.settled;

    assert.deepEqual(delivered, [
      { channel: "C123", threadTs: "1700000000.000100", text: "slack answer" }
    ]);
    const fresh = await db.aiRun.findUnique({ where: { id: run.id }, select: { status: true } });
    assert.equal(fresh?.status, "SUCCEEDED");
  } finally {
    await container.close();
    await cleanup(document.id, user.id);
  }
});
