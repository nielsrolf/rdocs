import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { collab, getVersion, receiveTransaction, sendableSteps } from "@tiptap/pm/collab";
import { EditorState } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";

import { db } from "../lib/db";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import {
  pullCollaborationSteps,
  submitCollaborationSteps,
  subscribeToCollaboration,
  type CollaborationStepPayload
} from "../lib/collaboration";
import { serializeDocumentContent } from "../lib/content";

// Regression for the "reopen shows a stale document" bug:
//
// Open document A, edit it, switch to another document, then switch back to A
// WITHOUT a hard refresh. The user saw A in its pre-edit state; only a page
// refresh revealed the edits.
//
// Mechanism: a soft navigation back to A re-seeds the editor from a STALE SSR
// snapshot (Next.js's client Router Cache replays the RSC payload captured at
// first open, so both initialContent and initialCollaborationVersion are the
// pre-edit values). The live SSE room streams only FUTURE steps — the "ready"
// event carries the current version but no backlog — and the fallback pull runs
// only while the stream is unhealthy. So nothing fetches the steps committed
// between the stale seed and the server's current version, and the tab stays
// stale until a hard refresh or a fresh edit.
//
// The fix makes the client pull once on connect. This test reproduces the whole
// flow over the REAL collaboration pipeline (real submit/pull/subscribe + real
// SQLite + real prosemirror-collab) and asserts that (a) connecting alone leaves
// the reopened tab stale — the bug — and (b) the connect-time catch-up pull
// brings it to the server's edited content with no refresh.

const schema = createDocumentEditorSchema();

function docJson(text: string) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function clientState(text: string, version: number, clientID: string) {
  return EditorState.create({
    doc: schema.nodeFromJSON(docJson(text)),
    plugins: [collab({ version, clientID })]
  });
}

function normalizeJson(json: unknown) {
  return JSON.stringify(schema.nodeFromJSON(json as never).toJSON());
}

async function createDoc(text: string) {
  const user = await db.user.create({
    data: { email: `reopen-${crypto.randomUUID()}@example.com`, name: "Reopen", passwordHash: "test" }
  });
  const document = await db.document.create({
    data: { title: "Reopen doc", content: serializeDocumentContent(docJson(text)), ownerId: user.id }
  });
  return { userId: user.id, documentId: document.id };
}

async function cleanupDoc(userId: string, documentId: string) {
  await db.$executeRawUnsafe("DELETE FROM CollaborationStep WHERE documentId = ?", documentId).catch(() => undefined);
  await db.documentVersion.deleteMany({ where: { documentId } }).catch(() => undefined);
  await db.document.deleteMany({ where: { id: documentId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
}

async function serverSubmit(documentId: string, clientId: string, version: number, steps: unknown[]) {
  const doc = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    select: { content: true, title: true, updatedAt: true }
  });
  return submitCollaborationSteps({
    documentId,
    rawContent: doc.content,
    currentTitle: doc.title,
    currentUpdatedAt: doc.updatedAt,
    version,
    steps,
    clientId
  });
}

async function serverPull(documentId: string, version: number) {
  const doc = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    select: { content: true, updatedAt: true }
  });
  return pullCollaborationSteps({ documentId, rawContent: doc.content, currentUpdatedAt: doc.updatedAt, version });
}

function applyPayload(state: EditorState, payload: Pick<CollaborationStepPayload, "steps" | "clientIds">) {
  if (!Array.isArray(payload.steps) || payload.steps.length === 0) return state;
  const steps = payload.steps.map((step) => Step.fromJSON(schema, step));
  return state.apply(receiveTransaction(state, steps, payload.clientIds, { mapSelectionBackward: true }));
}

test("reopening an edited document catches up to the latest content instead of a stale cached snapshot", async () => {
  const { userId, documentId } = await createDoc("ORIGINAL");
  try {
    // ── Editing session: the tab opens at ORIGINAL @ v0, types, and pushes.
    let editing = clientState("ORIGINAL", 0, "editor-tab");
    editing = editing.apply(editing.tr.insertText("EDITED ", 1));
    const sendable = sendableSteps(editing);
    assert.ok(sendable, "the editing tab has steps to push");
    const pushed = await serverSubmit(
      documentId,
      "editor-tab",
      sendable.version,
      sendable.steps.map((step) => step.toJSON())
    );
    assert.equal(pushed.accepted, true, "the edit is accepted by the server");
    editing = applyPayload(editing, pushed);

    // The server now holds the edited content at a NEW version.
    const serverDoc = await db.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { content: true, updatedAt: true }
    });
    assert.match(
      schema.nodeFromJSON(JSON.parse(serverDoc.content)).textContent,
      /EDITED/,
      "the server stored the edit"
    );
    const serverVersion = pushed.version;
    assert.ok(serverVersion > 0, "the durable version advanced past the seed");

    // ── Reopen via soft navigation. Next.js's Router Cache replays the RSC
    //    payload captured at first open, so the editor re-seeds at the STALE
    //    pre-edit snapshot: ORIGINAL @ v0 — NOT the server's current state.
    let reopened = clientState("ORIGINAL", 0, "reopen-tab");

    // Connecting to the live room yields a "ready" event with the CURRENT
    // version but NO backlog steps, so merely connecting cannot heal a stale
    // seed. This is precisely why the client must pull on connect.
    let readyVersion = -1;
    let backlogStepsOnConnect = 0;
    const unsubscribe = subscribeToCollaboration({
      documentId,
      rawContent: serverDoc.content,
      currentUpdatedAt: serverDoc.updatedAt,
      clientId: "reopen-tab",
      send: (event, payload) => {
        const data = payload as { version?: number; steps?: unknown[] };
        if (event === "ready" && typeof data.version === "number") readyVersion = data.version;
        if (event === "steps" && Array.isArray(data.steps)) backlogStepsOnConnect += data.steps.length;
      }
    });
    assert.equal(readyVersion, serverVersion, "the room reports the current version on connect");
    assert.equal(backlogStepsOnConnect, 0, "the SSE connect delivers no backlog steps");

    // Bug reproduction: after connecting, the reopened tab still shows ORIGINAL.
    assert.doesNotMatch(
      reopened.doc.textContent,
      /EDITED/,
      "connecting alone leaves the reopened tab stale (the reported bug)"
    );

    // ── The fix: pull the backlog since the seeded version on connect and apply.
    const catchUp = await serverPull(documentId, getVersion(reopened));
    reopened = applyPayload(reopened, catchUp);
    unsubscribe();

    // The reopened tab now matches the server's edited content — no refresh.
    assert.match(reopened.doc.textContent, /EDITED/, "the catch-up pull surfaces the edits");
    assert.equal(
      normalizeJson(reopened.doc.toJSON()),
      normalizeJson(JSON.parse(serverDoc.content)),
      "the reopened tab converges byte-for-byte with the server"
    );
  } finally {
    await cleanupDoc(userId, documentId);
  }
});
