import assert from "node:assert/strict";
import test from "node:test";

import { serializeDocumentContent } from "../lib/content";
import {
  forcePushDocument,
  getCollaborationRoom,
  submitCollaborationSteps,
  subscribeToCollaboration,
  updateCollaborationPresence,
  type CollaborationPresence
} from "../lib/collaboration";
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

function presenceFor(clientId: string): CollaborationPresence {
  return {
    clientId,
    userId: null,
    userName: "Test",
    color: "#fff",
    selection: null,
    typing: false,
    lastSeen: Date.now()
  };
}

async function createTestDocument(initialText: string) {
  const user = await db.user.create({
    data: {
      email: `forcepush-${crypto.randomUUID()}@example.com`,
      name: "Force Push Test",
      passwordHash: "test"
    }
  });
  const document = await db.document.create({
    data: {
      title: "Force push test",
      content: serializeDocumentContent(contentWithText(initialText)),
      ownerId: user.id
    }
  });
  return { user, document };
}

async function cleanup(userId: string, documentId: string) {
  await db
    .$executeRawUnsafe("DELETE FROM CollaborationStep WHERE documentId = ?", documentId)
    .catch(() => undefined);
  await db.documentVersion.deleteMany({ where: { documentId } }).catch(() => undefined);
  await db.document.deleteMany({ where: { id: documentId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
}

test("sole connected client can force-push its diverged state, resetting the step log", async () => {
  const { user, document } = await createTestDocument("server original");
  const unsubscribers: Array<() => void> = [];
  try {
    // Land a durable step from the sole client so durableVersion > 0 (mirrors a
    // real room that has accumulated edits before diverging).
    const room = getCollaborationRoom(document.id, document.content, document.updatedAt);
    void room;
    await submitCollaborationSteps({
      documentId: document.id,
      rawContent: document.content,
      currentTitle: document.title,
      currentUpdatedAt: document.updatedAt,
      version: 0,
      steps: [{ stepType: "replace", from: 1, to: 1, slice: { content: [{ type: "text", text: "X" }] } }],
      clientId: "sole-client"
    });
    const stepsBefore = await db.collaborationStep.count({ where: { documentId: document.id } });
    assert.ok(stepsBefore > 0, "expected at least one durable step before force-push");

    // Only the requesting client is connected.
    unsubscribers.push(
      subscribeToCollaboration({
        documentId: document.id,
        rawContent: document.content,
        clientId: "sole-client",
        send: () => undefined
      })
    );

    const persisted = await db.document.findUniqueOrThrow({
      where: { id: document.id },
      select: { content: true, title: true, updatedAt: true }
    });
    const result = await forcePushDocument({
      documentId: document.id,
      rawContent: persisted.content,
      currentTitle: persisted.title,
      currentUpdatedAt: persisted.updatedAt,
      clientId: "sole-client",
      content: contentWithText("client forced state")
    });

    assert.equal(result.forced, true);
    if (result.forced) {
      assert.equal(result.version, 0, "force-push resets the collaboration version to 0");
    }

    const saved = await db.document.findUniqueOrThrow({
      where: { id: document.id },
      select: { content: true }
    });
    assert.equal(textFromRawContent(saved.content), "client forced state");

    const stepsAfter = await db.collaborationStep.count({ where: { documentId: document.id } });
    assert.equal(stepsAfter, 0, "force-push clears the durable step log");

    // The overwritten server state is archived so the force-push is reversible.
    const versions = await db.documentVersion.findMany({ where: { documentId: document.id } });
    assert.ok(
      versions.some((v) => textFromRawContent(v.content).includes("server original")),
      "expected the overwritten server content to be archived in version history"
    );
  } finally {
    unsubscribers.forEach((u) => u());
    await cleanup(user.id, document.id);
  }
});

test("force-push is refused when another client is connected (SSE subscriber)", async () => {
  const { user, document } = await createTestDocument("server original");
  const unsubscribers: Array<() => void> = [];
  try {
    unsubscribers.push(
      subscribeToCollaboration({
        documentId: document.id,
        rawContent: document.content,
        clientId: "sole-client",
        send: () => undefined
      })
    );
    unsubscribers.push(
      subscribeToCollaboration({
        documentId: document.id,
        rawContent: document.content,
        clientId: "other-client",
        send: () => undefined
      })
    );

    const result = await forcePushDocument({
      documentId: document.id,
      rawContent: document.content,
      currentTitle: document.title,
      currentUpdatedAt: document.updatedAt,
      clientId: "sole-client",
      content: contentWithText("client forced state")
    });

    assert.equal(result.forced, false);
    const saved = await db.document.findUniqueOrThrow({
      where: { id: document.id },
      select: { content: true }
    });
    assert.equal(textFromRawContent(saved.content), "server original", "content must be untouched");
  } finally {
    unsubscribers.forEach((u) => u());
    await cleanup(user.id, document.id);
  }
});

test("force-push is refused when another client is present (recent presence, no SSE)", async () => {
  const { user, document } = await createTestDocument("server original");
  const unsubscribers: Array<() => void> = [];
  try {
    unsubscribers.push(
      subscribeToCollaboration({
        documentId: document.id,
        rawContent: document.content,
        clientId: "sole-client",
        send: () => undefined
      })
    );
    // A second client with live presence but no SSE subscriber registered here.
    updateCollaborationPresence({
      documentId: document.id,
      rawContent: document.content,
      currentUpdatedAt: document.updatedAt,
      presence: presenceFor("other-client")
    });

    const result = await forcePushDocument({
      documentId: document.id,
      rawContent: document.content,
      currentTitle: document.title,
      currentUpdatedAt: document.updatedAt,
      clientId: "sole-client",
      content: contentWithText("client forced state")
    });

    assert.equal(result.forced, false);
  } finally {
    unsubscribers.forEach((u) => u());
    await cleanup(user.id, document.id);
  }
});
