import assert from "node:assert/strict";
import test from "node:test";

import { collab, getVersion, receiveTransaction, sendableSteps } from "@tiptap/pm/collab";
import { EditorState } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";

import { db } from "../lib/db";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import { submitCollaborationSteps, pullCollaborationSteps } from "../lib/collaboration";
import { serializeDocumentContent } from "../lib/content";
import { COLLAB_MAX_STEPS_PER_PUSH, planCollaborationPush } from "../components/document-workspace/collaboration";

// ─────────────────────────────────────────────────────────────────────────────
// Regression for the "Save failed" that struck a large AI reformat: a single
// edit produced 500+ ProseMirror steps, the client flushed them all in ONE
// /collaboration POST, and the server rejected it with a non-recoverable 400
// ("steps:too_big") because the route caps a push at COLLAB_MAX_STEPS_PER_PUSH.
// The buffer never drained, so the tab stayed stuck on "Save failed" forever.
//
// The fix: the client chunks a large flush into batches no larger than the
// server cap, draining over several round-trips as each batch is confirmed.
// ─────────────────────────────────────────────────────────────────────────────

const schema = createDocumentEditorSchema();
const INITIAL_TEXT = "Sentence zero.";

function initialDocJson() {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: INITIAL_TEXT }] }] };
}

async function createDoc() {
  const user = await db.user.create({
    data: { email: `bigpush-${crypto.randomUUID()}@example.com`, name: "BigPush", passwordHash: "test" },
  });
  const document = await db.document.create({
    data: { title: "Big push doc", content: serializeDocumentContent(initialDocJson()), ownerId: user.id },
  });
  return { userId: user.id, documentId: document.id };
}

async function cleanupDoc(userId: string, documentId: string) {
  await db.$executeRawUnsafe("DELETE FROM CollaborationStep WHERE documentId = ?", documentId).catch(() => undefined);
  await db.documentVersion.deleteMany({ where: { documentId } }).catch(() => undefined);
  await db.document.deleteMany({ where: { id: documentId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
}

// A server that faithfully mirrors the /collaboration POST route, INCLUDING its
// hard cap on the number of steps in a single push (the route's zod
// `.max(COLLAB_MAX_STEPS_PER_PUSH)`). A push above the cap is the unrecoverable
// 400 that caused the bug — modelled here as a thrown 400 the caller must avoid
// by batching.
class CappedServer {
  pushSizes: number[] = [];
  constructor(readonly documentId: string) {}

  async submit(clientId: string, version: number, steps: unknown[]) {
    this.pushSizes.push(steps.length);
    if (steps.length > COLLAB_MAX_STEPS_PER_PUSH) {
      const err = new Error("Invalid collaboration step payload.") as Error & { status: number };
      err.status = 400;
      throw err;
    }
    const doc = await db.document.findUniqueOrThrow({
      where: { id: this.documentId },
      select: { content: true, title: true, updatedAt: true },
    });
    return submitCollaborationSteps({
      documentId: this.documentId,
      rawContent: doc.content,
      currentTitle: doc.title,
      currentUpdatedAt: doc.updatedAt,
      version,
      steps,
      clientId,
    });
  }
}

function freshClient(version: number, clientId: string, json: unknown) {
  return EditorState.create({
    doc: schema.nodeFromJSON(json as never),
    plugins: [collab({ version, clientID: clientId })],
  });
}

// Apply `count` independent single-character inserts so they accumulate as that
// many distinct unconfirmed collab steps (separate transactions don't merge in
// the collab plugin's pending buffer), reproducing a big multi-step edit.
function applyManySteps(state: EditorState, count: number) {
  let next = state;
  for (let i = 0; i < count; i += 1) {
    next = next.apply(next.tr.insertText("z", 1));
  }
  return next;
}

const BIG_STEP_COUNT = COLLAB_MAX_STEPS_PER_PUSH * 2 + 44; // 444 with cap=200 — well over one push

test("a single oversized push is rejected (reproduces the 'Save failed' bug)", async () => {
  const { userId, documentId } = await createDoc();
  const server = new CappedServer(documentId);
  try {
    let state = freshClient(0, "alice", initialDocJson());
    state = applyManySteps(state, BIG_STEP_COUNT);
    const sendable = sendableSteps(state);
    assert.ok(sendable && sendable.steps.length > COLLAB_MAX_STEPS_PER_PUSH);

    // The OLD client behavior: push every unconfirmed step at once.
    await assert.rejects(
      () => server.submit("alice", sendable!.version, sendable!.steps.map((s) => s.toJSON())),
      /Invalid collaboration step payload/
    );

    // Nothing was saved; the server is still at the original content/version.
    const saved = await db.document.findUniqueOrThrow({ where: { id: documentId }, select: { content: true } });
    assert.equal(schema.nodeFromJSON(JSON.parse(saved.content)).textContent, INITIAL_TEXT);
  } finally {
    await cleanupDoc(userId, documentId);
  }
});

test("a batched flush drains a large edit and converges", async () => {
  const { userId, documentId } = await createDoc();
  const server = new CappedServer(documentId);
  try {
    let state = freshClient(0, "alice", initialDocJson());
    state = applyManySteps(state, BIG_STEP_COUNT);

    // Faithful mirror of the client's batched flush loop: send at most one
    // batch per push, apply the confirmation (advancing the version), repeat.
    for (let guard = 0; guard < 100; guard += 1) {
      const sendable = sendableSteps(state);
      if (!sendable || sendable.steps.length === 0) break;
      const { batch } = planCollaborationPush(sendable.steps);
      const res = await server.submit("alice", sendable.version, batch.map((s) => s.toJSON()));
      assert.equal(res.accepted, true);
      const steps = res.steps.map((s) => Step.fromJSON(schema, s));
      state = state.apply(receiveTransaction(state, steps, res.clientIds, { mapSelectionBackward: true }));
    }

    // No single push ever exceeded the server cap.
    assert.ok(server.pushSizes.length >= 3, `expected multiple batches, got ${server.pushSizes.length}`);
    for (const size of server.pushSizes) {
      assert.ok(size <= COLLAB_MAX_STEPS_PER_PUSH, `push of ${size} exceeded cap ${COLLAB_MAX_STEPS_PER_PUSH}`);
    }

    // Buffer fully drained, and the server converged to the client's document.
    assert.equal(sendableSteps(state), null);
    const saved = await db.document.findUniqueOrThrow({ where: { id: documentId }, select: { content: true } });
    assert.equal(JSON.stringify(JSON.parse(saved.content)), JSON.stringify(state.doc.toJSON()));

    // And the durable step log replays to the same document.
    const log = await pullCollaborationSteps({ documentId, rawContent: saved.content, version: 0 });
    let replay = schema.nodeFromJSON(initialDocJson());
    for (const sj of log.steps) {
      const result = Step.fromJSON(schema, sj).apply(replay);
      assert.ok(!result.failed && result.doc);
      replay = result.doc!;
    }
    assert.equal(JSON.stringify(replay.toJSON()), JSON.stringify(state.doc.toJSON()));
    assert.equal(getVersion(state), BIG_STEP_COUNT);
  } finally {
    await cleanupDoc(userId, documentId);
  }
});
