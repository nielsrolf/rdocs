import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  AI_RUN_EVENT_RUNS,
  AI_RUN_LIST_LIMIT,
  fetchDocumentAiRuns
} from "../lib/ai-runs";
import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";

// Regression: the document poll returned only the newest 12 AiRun rows, so the
// agent view of a busy document (e.g. a Slack channel doc where every mention
// is a run) showed only a handful of conversations — everything older simply
// vanished from the sidebar. The list must go far deeper; to keep the 2s poll
// payload sane, only the newest runs carry their event timelines inline and
// older runs are flagged `eventsOmitted` so the client can lazy-load them.

async function makeDocWithRuns(runCount: number) {
  const user = await db.user.create({
    data: {
      email: `run-list-window-${crypto.randomUUID()}@example.com`,
      name: "run list window",
      passwordHash: "x"
    }
  });
  const document = await db.document.create({
    data: {
      title: "Run list window test",
      content: serializeDocumentContent({ type: "doc", content: [{ type: "paragraph" }] }),
      ownerId: user.id
    }
  });
  const base = Date.now() - runCount * 60_000;
  const runIds: string[] = [];
  for (let i = 0; i < runCount; i++) {
    const run = await db.aiRun.create({
      data: {
        documentId: document.id,
        triggerType: "CONVERSATION",
        instruction: `run ${i}`,
        status: "SUCCEEDED",
        startedAt: new Date(base + i * 60_000),
        finishedAt: new Date(base + i * 60_000 + 30_000)
      }
    });
    await db.aiRunEvent.create({
      data: { aiRunId: run.id, role: "assistant", message: `reply ${i}` }
    });
    runIds.push(run.id);
  }
  return { user, document, runIds };
}

test("the run list keeps old conversations visible, with events inline only for recent runs", async () => {
  const total = AI_RUN_EVENT_RUNS + 8; // more runs than the inline-event window
  const { user, document } = await makeDocWithRuns(total);
  try {
    const runs = await fetchDocumentAiRuns(document.id);

    assert.equal(
      runs.length,
      Math.min(total, AI_RUN_LIST_LIMIT),
      `all ${total} runs must be returned (old conversations must not vanish from the agent view)`
    );
    // Newest first.
    assert.equal(runs[0]?.instruction, `run ${total - 1}`);
    assert.equal(runs[runs.length - 1]?.instruction, "run 0");

    const recent = runs.slice(0, AI_RUN_EVENT_RUNS);
    const older = runs.slice(AI_RUN_EVENT_RUNS);
    for (const run of recent) {
      assert.equal(run.eventsOmitted, false, "recent runs carry events inline");
      assert.equal(run.events.length, 1, `recent run ${run.instruction} has its event`);
    }
    assert.ok(older.length > 0, "test must cover the omitted-events tail");
    for (const run of older) {
      assert.equal(run.eventsOmitted, true, "older runs are flagged for lazy event loading");
      assert.equal(run.events.length, 0, "older runs do not ship events in the poll");
    }
  } finally {
    await db.document.delete({ where: { id: document.id } }).catch(() => null);
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
  }
});
