import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { resolveConversationRootRunId } from "../lib/ai-runs";
import { buildRunPermalink } from "../lib/request-origin";
import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";

// The run permalink `${APP_URL}/documents/<id>?run=<aiRunId>` deep-links into a
// document's agent panel: the page resolves ?run= to its conversation ROOT run
// (conversation selection is keyed by the root), and the container runner
// exposes the same URL to the agent as GDOCS_RUN_URL.

test("buildRunPermalink uses the configured APP_URL, and yields null without one", () => {
  const previous = process.env.APP_URL;
  try {
    process.env.APP_URL = "https://docs.example.com";
    assert.equal(
      buildRunPermalink("doc-1", "run-1"),
      "https://docs.example.com/documents/doc-1?run=run-1"
    );
    delete process.env.APP_URL;
    assert.equal(buildRunPermalink("doc-1", "run-1"), null);
  } finally {
    if (previous === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previous;
  }
});

async function makeDoc() {
  const user = await db.user.create({
    data: {
      email: `run-permalink-${crypto.randomUUID()}@example.com`,
      name: "run permalink",
      passwordHash: "x"
    }
  });
  const document = await db.document.create({
    data: {
      title: "Run permalink test",
      content: serializeDocumentContent({ type: "doc", content: [{ type: "paragraph" }] }),
      ownerId: user.id
    }
  });
  return { user, document };
}

async function makeRun(documentId: string, parentRunId: string | null) {
  return db.aiRun.create({
    data: {
      documentId,
      triggerType: "CONVERSATION",
      instruction: "permalink test run",
      status: "SUCCEEDED",
      parentRunId,
      finishedAt: new Date()
    }
  });
}

test("a deep-linked follow-up run resolves to its conversation root", async () => {
  const { user, document } = await makeDoc();
  const { user: otherUser, document: otherDocument } = await makeDoc();
  try {
    const root = await makeRun(document.id, null);
    const child = await makeRun(document.id, root.id);
    const grandchild = await makeRun(document.id, child.id);

    assert.equal(await resolveConversationRootRunId(document.id, grandchild.id), root.id);
    assert.equal(await resolveConversationRootRunId(document.id, child.id), root.id);
    assert.equal(await resolveConversationRootRunId(document.id, root.id), root.id);

    // A run that doesn't exist, or that belongs to a DIFFERENT document, must
    // not leak into the requested document's agent panel.
    assert.equal(await resolveConversationRootRunId(document.id, "no-such-run"), null);
    assert.equal(await resolveConversationRootRunId(otherDocument.id, child.id), null);
  } finally {
    await db.document.delete({ where: { id: document.id } }).catch(() => null);
    await db.document.delete({ where: { id: otherDocument.id } }).catch(() => null);
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
    await db.user.delete({ where: { id: otherUser.id } }).catch(() => null);
  }
});

test("a cyclic parent chain terminates at the walk cap instead of looping", async () => {
  const { user, document } = await makeDoc();
  try {
    const a = await makeRun(document.id, null);
    const b = await makeRun(document.id, a.id);
    // Corrupt the chain into a cycle a -> b -> a.
    await db.aiRun.update({ where: { id: a.id }, data: { parentRunId: b.id } });
    const resolved = await resolveConversationRootRunId(document.id, b.id);
    assert.ok(resolved === a.id || resolved === b.id, "resolution must terminate on a run in the cycle");
  } finally {
    await db.document.delete({ where: { id: document.id } }).catch(() => null);
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
  }
});
