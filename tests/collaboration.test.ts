import assert from "node:assert/strict";
import test from "node:test";

import { collab, receiveTransaction, sendableSteps } from "@tiptap/pm/collab";
import { EditorState } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";

import { serializeDocumentContent } from "../lib/content";
import { submitCollaborationSteps, getCollaborationRoom } from "../lib/collaboration";
import { db } from "../lib/db";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";

const schema = createDocumentEditorSchema();

function contentWithText(text: string) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: text ? [{ type: "text", text }] : undefined
      }
    ]
  };
}

function textFromRawContent(rawContent: string) {
  return schema.nodeFromJSON(JSON.parse(rawContent)).textContent;
}

function createClientState(text: string, version: number, clientID: string) {
  return EditorState.create({
    doc: schema.nodeFromJSON(contentWithText(text)),
    plugins: [collab({ version, clientID })]
  });
}

function insertText(state: EditorState, text: string, pos = 1) {
  return state.apply(state.tr.insertText(text, pos));
}

function payloadFromState(state: EditorState) {
  const sendable = sendableSteps(state);
  assert.ok(sendable, "expected pending collaboration steps");
  return {
    version: sendable.version,
    steps: sendable.steps.map((step) => step.toJSON())
  };
}

function applyPayload(
  state: EditorState,
  payload: { steps: unknown[]; clientIds: Array<string | number> }
) {
  const steps = payload.steps.map((step) => Step.fromJSON(schema, step));
  return state.apply(receiveTransaction(state, steps, payload.clientIds));
}

async function createTestDocument(initialText: string) {
  const user = await db.user.create({
    data: {
      email: `collab-${crypto.randomUUID()}@example.com`,
      name: "Collab Test",
      passwordHash: "test"
    }
  });

  const document = await db.document.create({
    data: {
      title: "Collaboration test",
      content: serializeDocumentContent(contentWithText(initialText)),
      ownerId: user.id
    }
  });

  return { user, document };
}

async function cleanupTestDocument(userId: string, documentId: string) {
  await db.$executeRawUnsafe("DELETE FROM CollaborationStep WHERE documentId = ?", documentId).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
}

test("collaboration merges against the persisted document even when the in-memory room is stale", async () => {
  const { user, document } = await createTestDocument("Weather tomorrow in Berlinfff");

  try {
    getCollaborationRoom(
      document.id,
      serializeDocumentContent(contentWithText("Start writing.")),
      document.updatedAt
    );

    let niels = createClientState("Weather tomorrow in Berlinfff", 0, "niels");
    niels = insertText(niels, "hhhhhhh");
    const payload = payloadFromState(niels);

    const result = await submitCollaborationSteps({
      documentId: document.id,
      rawContent: document.content,
      currentTitle: document.title,
      currentUpdatedAt: document.updatedAt,
      version: payload.version,
      steps: payload.steps,
      clientId: "niels"
    });

    assert.equal(result.accepted, true);

    const saved = await db.document.findUniqueOrThrow({
      where: { id: document.id },
      select: { content: true }
    });
    assert.equal(textFromRawContent(saved.content), "hhhhhhhWeather tomorrow in Berlinfff");
  } finally {
    await cleanupTestDocument(user.id, document.id);
  }
});

test("a stale browser can apply missing remote steps, retry its local edit, and converge", async () => {
  const { user, document } = await createTestDocument("Weather tomorrow in Berlinfff");

  try {
    let guest = createClientState("Weather tomorrow in Berlinfff", 0, "guest");
    let niels = createClientState("Weather tomorrow in Berlinfff", 0, "niels");

    niels = insertText(niels, "hhhhhhh");
    const nielsPayload = payloadFromState(niels);
    const nielsResult = await submitCollaborationSteps({
      documentId: document.id,
      rawContent: document.content,
      currentTitle: document.title,
      currentUpdatedAt: document.updatedAt,
      version: nielsPayload.version,
      steps: nielsPayload.steps,
      clientId: "niels"
    });
    assert.equal(nielsResult.accepted, true);

    guest = insertText(guest, "yo yo ");
    const staleGuestPayload = payloadFromState(guest);
    const updatedAfterNiels = await db.document.findUniqueOrThrow({
      where: { id: document.id },
      select: { title: true, content: true, updatedAt: true }
    });
    const staleGuestResult = await submitCollaborationSteps({
      documentId: document.id,
      rawContent: updatedAfterNiels.content,
      currentTitle: updatedAfterNiels.title,
      currentUpdatedAt: updatedAfterNiels.updatedAt,
      version: staleGuestPayload.version,
      steps: staleGuestPayload.steps,
      clientId: "guest"
    });

    assert.equal(staleGuestResult.accepted, false);
    assert.equal(staleGuestResult.version, 1);
    assert.equal(staleGuestResult.steps.length, 1);

    guest = applyPayload(guest, staleGuestResult);
    const rebasedGuestPayload = payloadFromState(guest);
    assert.equal(rebasedGuestPayload.version, 1);

    const latest = await db.document.findUniqueOrThrow({
      where: { id: document.id },
      select: { title: true, content: true, updatedAt: true }
    });
    const retryResult = await submitCollaborationSteps({
      documentId: document.id,
      rawContent: latest.content,
      currentTitle: latest.title,
      currentUpdatedAt: latest.updatedAt,
      version: rebasedGuestPayload.version,
      steps: rebasedGuestPayload.steps,
      clientId: "guest"
    });

    assert.equal(retryResult.accepted, true);

    const saved = await db.document.findUniqueOrThrow({
      where: { id: document.id },
      select: { content: true }
    });
    const savedText = textFromRawContent(saved.content);
    assert.match(savedText, /Weather tomorrow in Berlinfff/);
    assert.match(savedText, /hhhhhhh/);
    assert.match(savedText, /yo yo /);
  } finally {
    await cleanupTestDocument(user.id, document.id);
  }
});

test("owner edit after guest edit uses the latest saved base even if the route read stale content", async () => {
  const { user, document } = await createTestDocument("Weather tomorrow in Berlinfff");

  try {
    let guest = createClientState("Weather tomorrow in Berlinfff", 0, "guest");
    let owner = createClientState("Weather tomorrow in Berlinfff", 0, "owner");

    guest = insertText(guest, "gggg", 4);
    const guestPayload = payloadFromState(guest);
    const guestResult = await submitCollaborationSteps({
      documentId: document.id,
      rawContent: document.content,
      currentTitle: document.title,
      currentUpdatedAt: document.updatedAt,
      version: guestPayload.version,
      steps: guestPayload.steps,
      clientId: "guest"
    });
    assert.equal(guestResult.accepted, true);

    owner = applyPayload(owner, guestResult);
    owner = insertText(owner, "jj", owner.doc.content.size);
    const ownerPayload = payloadFromState(owner);
    assert.equal(ownerPayload.version, 1);

    const ownerResult = await submitCollaborationSteps({
      documentId: document.id,
      rawContent: document.content,
      currentTitle: document.title,
      currentUpdatedAt: document.updatedAt,
      version: ownerPayload.version,
      steps: ownerPayload.steps,
      clientId: "owner"
    });

    assert.equal(ownerResult.accepted, true);

    const saved = await db.document.findUniqueOrThrow({
      where: { id: document.id },
      select: { content: true }
    });
    assert.equal(textFromRawContent(saved.content), "Weaggggther tomorrow in Berlinfffjj");
  } finally {
    await cleanupTestDocument(user.id, document.id);
  }
});
