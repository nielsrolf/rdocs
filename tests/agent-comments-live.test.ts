import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { mergeBufferedComments } from "../agent-core/ai-edit-submission";
import { createLiveCommentRecorder } from "../lib/agent-comments";
import { db } from "../lib/db";

const DOC_TEXT = "The quick brown fox jumps over the lazy dog.";

async function createFixture() {
  const user = await db.user.create({
    data: { email: `live-${crypto.randomUUID()}@example.com`, name: "Live Cmt", passwordHash: "x" }
  });
  const document = await db.document.create({
    data: { title: "Live comments", content: "{}", ownerId: user.id }
  });
  const run = await db.aiRun.create({
    data: { documentId: document.id, triggerType: "CONVERSATION", instruction: "review" }
  });
  return { user, document, run };
}

async function cleanup(fixture: { user: { id: string }; document: { id: string }; run: { id: string } }) {
  await db.aiRun.delete({ where: { id: fixture.run.id } }).catch(() => undefined);
  await db.document.delete({ where: { id: fixture.document.id } }).catch(() => undefined);
  await db.user.delete({ where: { id: fixture.user.id } }).catch(() => undefined);
}

test("onComment creates the thread immediately and snapshots AiRun.agentComments", async () => {
  const fixture = await createFixture();
  try {
    const recorder = createLiveCommentRecorder({
      documentId: fixture.document.id,
      aiRunId: fixture.run.id,
      createdById: fixture.user.id,
      model: "claude-sonnet-5",
      documentText: DOC_TEXT
    });

    await recorder.onComment({ findText: "quick brown fox", body: "Nice imagery." });

    const threads = await db.commentThread.findMany({
      where: { documentId: fixture.document.id },
      include: { comments: true }
    });
    assert.equal(threads.length, 1);
    assert.equal(threads[0].anchorText, "quick brown fox");
    assert.equal(threads[0].comments[0].body, "Nice imagery.");
    assert.equal(threads[0].comments[0].aiRunId, fixture.run.id);
    assert.equal(threads[0].comments[0].aiModel, "claude-sonnet-5");

    const run = await db.aiRun.findUnique({ where: { id: fixture.run.id }, select: { agentComments: true } });
    const snapshot = JSON.parse(run?.agentComments ?? "[]");
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].threadId, threads[0].id);
    assert.equal(snapshot[0].findText, "quick brown fox");

    // A repeated identical comment (e.g. from a retried attempt) is ignored.
    await recorder.onComment({ findText: "quick brown fox", body: "Nice imagery." });
    assert.equal(await db.commentThread.count({ where: { documentId: fixture.document.id } }), 1);
  } finally {
    await cleanup(fixture);
  }
});

test("finalize creates only the comments not already delivered live, returns the full list", async () => {
  const fixture = await createFixture();
  try {
    const recorder = createLiveCommentRecorder({
      documentId: fixture.document.id,
      aiRunId: fixture.run.id,
      createdById: fixture.user.id,
      model: "claude-sonnet-5",
      documentText: DOC_TEXT
    });

    await recorder.onComment({ findText: "quick brown fox", body: "Nice imagery." });
    const all = await recorder.finalize(
      [
        { findText: "quick brown fox", body: "Nice imagery." }, // duplicate of the live one
        { findText: "lazy dog", body: "Consider a livelier dog." }
      ],
      "claude-agent-sdk:claude-sonnet-5"
    );

    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((entry) => entry.findText),
      ["quick brown fox", "lazy dog"]
    );
    assert.equal(await db.commentThread.count({ where: { documentId: fixture.document.id } }), 2);
  } finally {
    await cleanup(fixture);
  }
});

test("mergeBufferedComments prepends buffered comments not repeated in the submission", () => {
  const merged = mergeBufferedComments(
    [{ findText: "a", body: "1" }],
    [
      { findText: "a", body: "1" },
      { findText: "b", body: "2" }
    ]
  );
  assert.deepEqual(merged, [
    { findText: "b", body: "2" },
    { findText: "a", body: "1" }
  ]);
});
