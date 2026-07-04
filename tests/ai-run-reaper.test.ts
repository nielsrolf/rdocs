import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { failAbandonedAiRuns, STALE_AI_RUN_MS } from "../lib/ai-runs";
import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";

// Regression: the stale-run reaper used to judge staleness by run *age*
// (startedAt), killing healthy long runs that were still heartbeating via
// AiRunEvents — e.g. an agent blocked on a 10-minute TaskOutput wait 15
// minutes into a big edit. Staleness must be judged by *silence* (time since
// the last run event, or startedAt when there are none), not total runtime.

function content() {
  return serializeDocumentContent({ type: "doc", content: [{ type: "paragraph" }] });
}

async function makeDoc(label: string) {
  const user = await db.user.create({
    data: { email: `reaper-${label}-${crypto.randomUUID()}@example.com`, name: label, passwordHash: "x" }
  });
  const document = await db.document.create({
    data: { title: "Reaper test", content: content(), ownerId: user.id }
  });
  return { user, document };
}

async function makeRun(documentId: string, startedAgoMs: number, now: number) {
  return db.aiRun.create({
    data: {
      documentId,
      triggerType: "SELECTION_EDIT",
      instruction: "test run",
      status: "RUNNING",
      startedAt: new Date(now - startedAgoMs)
    }
  });
}

async function cleanup(documentId: string, userId: string) {
  await db.document.delete({ where: { id: documentId } }).catch(() => null);
  await db.user.delete({ where: { id: userId } }).catch(() => null);
}

test("a long run that is still emitting events is NOT reaped", async () => {
  const { user, document } = await makeDoc("alive");
  const now = Date.now();
  try {
    // Started well past the stale threshold...
    const run = await makeRun(document.id, STALE_AI_RUN_MS + 8 * 60 * 1000, now);
    // ...but heartbeated one minute ago.
    await db.aiRunEvent.create({
      data: {
        aiRunId: run.id,
        role: "tool",
        message: "TaskOutput: waiting on subagent",
        createdAt: new Date(now - 60 * 1000)
      }
    });

    const reaped = await failAbandonedAiRuns([run], now);

    assert.equal(reaped?.failedIds.has(run.id) ?? false, false, "active run must not be marked abandoned");
    const fresh = await db.aiRun.findUnique({ where: { id: run.id }, select: { status: true, error: true } });
    assert.equal(fresh?.status, "RUNNING", "run should still be RUNNING in the DB");
    assert.equal(fresh?.error, null);
  } finally {
    await cleanup(document.id, user.id);
  }
});

test("a run silent for longer than the threshold IS reaped", async () => {
  const { user, document } = await makeDoc("dead");
  const now = Date.now();
  try {
    const run = await makeRun(document.id, STALE_AI_RUN_MS + 20 * 60 * 1000, now);
    // Last sign of life is older than the silence threshold.
    await db.aiRunEvent.create({
      data: {
        aiRunId: run.id,
        role: "agent",
        message: "last words",
        createdAt: new Date(now - STALE_AI_RUN_MS - 60 * 1000)
      }
    });

    const reaped = await failAbandonedAiRuns([run], now);

    assert.equal(reaped?.failedIds.has(run.id), true, "silent run must be marked abandoned");
    const fresh = await db.aiRun.findUnique({ where: { id: run.id }, select: { status: true, error: true } });
    assert.equal(fresh?.status, "FAILED");
    assert.match(fresh?.error ?? "", /abandoned/i);
  } finally {
    await cleanup(document.id, user.id);
  }
});

test("a run with no events at all is reaped once past the threshold", async () => {
  const { user, document } = await makeDoc("noevents");
  const now = Date.now();
  try {
    const run = await makeRun(document.id, STALE_AI_RUN_MS + 60 * 1000, now);

    const reaped = await failAbandonedAiRuns([run], now);

    assert.equal(reaped?.failedIds.has(run.id), true, "eventless stale run must be marked abandoned");
    const fresh = await db.aiRun.findUnique({ where: { id: run.id }, select: { status: true } });
    assert.equal(fresh?.status, "FAILED");
  } finally {
    await cleanup(document.id, user.id);
  }
});

test("a young run is left alone", async () => {
  const { user, document } = await makeDoc("young");
  const now = Date.now();
  try {
    const run = await makeRun(document.id, 60 * 1000, now);

    const reaped = await failAbandonedAiRuns([run], now);

    assert.equal(reaped?.failedIds.has(run.id) ?? false, false);
    const fresh = await db.aiRun.findUnique({ where: { id: run.id }, select: { status: true } });
    assert.equal(fresh?.status, "RUNNING");
  } finally {
    await cleanup(document.id, user.id);
  }
});
