import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { AI_RUN_EVENT_WINDOW, fetchDocumentAiRuns } from "../lib/ai-runs";
import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";

// Regression: the document poll fetched run events with orderBy asc + take N,
// which returns the FIRST N events of a run. Once a long run outgrew the
// window, the agent timeline froze — every new tool call and message fell
// outside the window and was never shown. The window must keep the LATEST
// events (still in chronological order for rendering).

async function makeDocWithRun() {
  const user = await db.user.create({
    data: {
      email: `event-window-${crypto.randomUUID()}@example.com`,
      name: "event window",
      passwordHash: "x"
    }
  });
  const document = await db.document.create({
    data: {
      title: "Event window test",
      content: serializeDocumentContent({ type: "doc", content: [{ type: "paragraph" }] }),
      ownerId: user.id
    }
  });
  const run = await db.aiRun.create({
    data: {
      documentId: document.id,
      triggerType: "CONVERSATION",
      instruction: "long run",
      status: "RUNNING"
    }
  });
  return { user, document, run };
}

test("a run that outgrows the event window shows its latest events, oldest dropped", async () => {
  const { user, document, run } = await makeDocWithRun();
  try {
    const total = AI_RUN_EVENT_WINDOW + 5;
    const base = Date.now() - total * 1000;
    // createMany preserves insertion order; distinct createdAt makes order deterministic.
    await db.aiRunEvent.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        aiRunId: run.id,
        role: "tool",
        message: `event ${i}`,
        createdAt: new Date(base + i * 1000)
      }))
    });

    const runs = await fetchDocumentAiRuns(document.id);
    const events = runs.find((r) => r.id === run.id)?.events ?? [];

    assert.equal(events.length, AI_RUN_EVENT_WINDOW, "window size respected");
    assert.equal(
      events[events.length - 1]?.message,
      `event ${total - 1}`,
      "the newest event must be inside the window"
    );
    assert.equal(
      events[0]?.message,
      `event ${total - AI_RUN_EVENT_WINDOW}`,
      "the oldest events are the ones dropped"
    );
    for (let i = 1; i < events.length; i++) {
      assert.ok(
        new Date(events[i - 1].createdAt).getTime() <= new Date(events[i].createdAt).getTime(),
        "events stay in chronological order for rendering"
      );
    }
  } finally {
    await db.document.delete({ where: { id: document.id } }).catch(() => null);
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
  }
});
