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

// Regression (2026-11-10): the credential broker records one `[usage] {...}`
// event per brokered model call. A run whose own code makes thousands of LLM
// calls (an eval) wrote ~9,700 of them, which filled the poll's newest-80
// window AND the detail route's cap — the agent view showed nothing but usage
// lines: no prompt, no tool calls, no results. Usage rows are accounting, not
// timeline; they must never occupy the event window, and come back summarized.
test("brokered usage events never crowd the prompt and tool calls out of the timeline", async () => {
  const { user, document, runIds } = await makeDocWithRuns(1);
  const runId = runIds[0];
  try {
    await db.aiRunEvent.deleteMany({ where: { aiRunId: runId } });
    const t0 = Date.now() - 60_000;
    await db.aiRunEvent.createMany({
      data: [
        { aiRunId: runId, role: "user", message: "Run the eval.", createdAt: new Date(t0) },
        { aiRunId: runId, role: "tool", message: 'Bash: {"command":"python run_eval.py"}', createdAt: new Date(t0 + 1) },
        ...Array.from({ length: 300 }, (_, i) => ({
          aiRunId: runId,
          role: "system",
          message: `[usage] ${JSON.stringify({
            requestId: `r${i}`, provider: "litellm", costUsd: 0.0001, model: i % 3 === 0 ? "model-b" : "model-a",
            inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, complete: true
          })}`,
          createdAt: new Date(t0 + 10 + i)
        }))
      ]
    });

    const [run] = await fetchDocumentAiRuns(document.id);
    assert.deepEqual(
      run.events.map((event) => event.role),
      ["user", "tool"],
      "the prompt and the tool call are in the window; usage rows are not"
    );
    assert.equal(run.eventsClipped, false, "usage rows do not count toward the window");
    assert.ok(run.usage, "usage comes back as a summary");
    assert.equal(run.usage.calls, 300);
    assert.equal(run.usage.inputTokens, 3000);
    assert.equal(run.usage.outputTokens, 600);
    assert.ok(Math.abs((run.usage.costUsd ?? 0) - 0.03) < 1e-9);
    assert.deepEqual(
      run.usage.models.map((entry) => [entry.model, entry.calls]),
      [["model-a", 200], ["model-b", 100]]
    );
  } finally {
    await db.document.delete({ where: { id: document.id } }).catch(() => null);
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
  }
});
