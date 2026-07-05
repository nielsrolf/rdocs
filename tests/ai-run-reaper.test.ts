import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { failAbandonedAiRuns, markAiRunSucceeded, startAiRunHeartbeat, STALE_AI_RUN_MS } from "../lib/ai-runs";
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

async function makeRun(
  documentId: string,
  startedAgoMs: number,
  now: number,
  heartbeatAgoMs?: number
) {
  return db.aiRun.create({
    data: {
      documentId,
      triggerType: "SELECTION_EDIT",
      instruction: "test run",
      status: "RUNNING",
      startedAt: new Date(now - startedAgoMs),
      heartbeatAt: heartbeatAgoMs === undefined ? null : new Date(now - heartbeatAgoMs)
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

// Regression: agents blocked on long tool waits (Monitor calls run up to an
// hour) emit no AiRunEvents at all, so event silence alone false-flagged
// healthy runs. The runner now ticks AiRun.heartbeatAt every minute for as
// long as the owning process is alive; a fresh heartbeat must count as
// activity even when the event log has been silent past the threshold.
test("a run with stale events but a fresh runner heartbeat is NOT reaped", async () => {
  const { user, document } = await makeDoc("heartbeat");
  const now = Date.now();
  try {
    // Started an hour ago, heartbeated one minute ago...
    const run = await makeRun(document.id, 60 * 60 * 1000, now, 60 * 1000);
    // ...but the last event (entering the long tool wait) is past the threshold.
    await db.aiRunEvent.create({
      data: {
        aiRunId: run.id,
        role: "tool",
        message: "Monitor: waiting on experiment",
        createdAt: new Date(now - STALE_AI_RUN_MS - 5 * 60 * 1000)
      }
    });

    const reaped = await failAbandonedAiRuns([run], now);

    assert.equal(reaped?.failedIds.has(run.id) ?? false, false, "heartbeating run must not be marked abandoned");
    const fresh = await db.aiRun.findUnique({ where: { id: run.id }, select: { status: true, error: true } });
    assert.equal(fresh?.status, "RUNNING");
    assert.equal(fresh?.error, null);
  } finally {
    await cleanup(document.id, user.id);
  }
});

test("a run whose heartbeat also went silent IS reaped", async () => {
  const { user, document } = await makeDoc("dead-heartbeat");
  const now = Date.now();
  try {
    // Both the event log and the heartbeat are past the silence threshold —
    // the owning server process is gone (restart/crash).
    const run = await makeRun(document.id, 60 * 60 * 1000, now, STALE_AI_RUN_MS + 60 * 1000);
    await db.aiRunEvent.create({
      data: {
        aiRunId: run.id,
        role: "agent",
        message: "last words",
        createdAt: new Date(now - STALE_AI_RUN_MS - 5 * 60 * 1000)
      }
    });

    const reaped = await failAbandonedAiRuns([run], now);

    assert.equal(reaped?.failedIds.has(run.id), true, "run without heartbeat or events must be reaped");
    const fresh = await db.aiRun.findUnique({ where: { id: run.id }, select: { status: true } });
    assert.equal(fresh?.status, "FAILED");
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

test("startAiRunHeartbeat ticks heartbeatAt immediately and stops cleanly", async () => {
  const { user, document } = await makeDoc("hb-writer");
  const now = Date.now();
  try {
    const run = await makeRun(document.id, 60 * 1000, now);
    const stop = startAiRunHeartbeat(run.id);
    try {
      // The first tick fires synchronously but writes async; give it a beat.
      const deadline = Date.now() + 2000;
      let heartbeatAt: Date | null = null;
      while (!heartbeatAt && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        heartbeatAt = (await db.aiRun.findUnique({ where: { id: run.id }, select: { heartbeatAt: true } }))
          ?.heartbeatAt ?? null;
      }
      assert.ok(heartbeatAt, "heartbeatAt should be written by the initial tick");
    } finally {
      stop();
    }

    // A tick must never touch a run that already reached a terminal state.
    await db.aiRun.update({
      where: { id: run.id },
      data: { status: "SUCCEEDED", heartbeatAt: null }
    });
    const stopAgain = startAiRunHeartbeat(run.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    stopAgain();
    const fresh = await db.aiRun.findUnique({ where: { id: run.id }, select: { heartbeatAt: true } });
    assert.equal(fresh?.heartbeatAt, null, "terminal runs must not be heartbeated");
  } finally {
    await cleanup(document.id, user.id);
  }
});

// Regression: the reaper only flips the DB row — it cannot kill the process.
// A falsely-reaped run that later finishes flips FAILED -> SUCCEEDED but used
// to keep the stale "Run abandoned (server restart or crash)." error text,
// leaving the run in a contradictory SUCCEEDED-with-error state.
test("a reaped run that later succeeds sheds the stale abandoned error", async () => {
  const { user, document } = await makeDoc("late-success");
  const now = Date.now();
  try {
    const run = await makeRun(document.id, STALE_AI_RUN_MS + 20 * 60 * 1000, now);
    const reaped = await failAbandonedAiRuns([run], now);
    assert.equal(reaped?.failedIds.has(run.id), true, "precondition: run was reaped");

    // The still-alive runner finishes and records its result.
    await markAiRunSucceeded(run.id, { replacementText: "the results" });

    const fresh = await db.aiRun.findUnique({
      where: { id: run.id },
      select: { status: true, error: true, replacementText: true }
    });
    assert.equal(fresh?.status, "SUCCEEDED");
    assert.equal(fresh?.replacementText, "the results");
    assert.equal(fresh?.error, null, "success must clear the reaper's stale error text");
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
