import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { collab, sendableSteps } from "@tiptap/pm/collab";
import { EditorState } from "@tiptap/pm/state";

import { parseSourceLinks } from "../lib/sources";
import { serializeDocumentContent } from "../lib/content";
import { submitCollaborationSteps, getCollaborationVersion } from "../lib/collaboration";
import { db } from "../lib/db";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";

// Regression coverage for the "saving silently failed / work was lost" and
// "saving failed after an AI edit" bug classes. Everything goes through the real
// submitCollaborationSteps + real SQLite, so a desync between Document.content
// and the durable CollaborationStep log (the historical root cause) is caught.

const schema = createDocumentEditorSchema();

function contentWithText(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }]
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

function payloadFromState(state: EditorState) {
  const sendable = sendableSteps(state);
  assert.ok(sendable, "expected pending collaboration steps");
  return { version: sendable.version, steps: sendable.steps.map((step) => step.toJSON()) };
}

async function createTestDocument(initialText: string) {
  const user = await db.user.create({
    data: { email: `save-${crypto.randomUUID()}@example.com`, name: "Save Test", passwordHash: "test" }
  });
  const document = await db.document.create({
    data: {
      title: "Save test",
      content: serializeDocumentContent(contentWithText(initialText)),
      ownerId: user.id
    }
  });
  return { user, document };
}

async function cleanup(userId: string, documentId: string) {
  await db.$executeRawUnsafe("DELETE FROM CollaborationStep WHERE documentId = ?", documentId).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
}

async function durableStepCount(documentId: string) {
  const rows = await db.$queryRawUnsafe<Array<{ c: number | bigint }>>(
    "SELECT COUNT(*) AS c FROM CollaborationStep WHERE documentId = ?",
    documentId
  );
  return Number(rows[0]?.c ?? 0);
}

test("an edit round-trips: persisted content matches and a durable step is recorded", async () => {
  const { user, document } = await createTestDocument("Hello world");
  try {
    let client = createClientState("Hello world", 0, "client-a");
    client = client.apply(client.tr.insertText("brave new ", 7));
    const payload = payloadFromState(client);

    const result = await submitCollaborationSteps({
      documentId: document.id,
      rawContent: document.content,
      currentTitle: document.title,
      currentUpdatedAt: document.updatedAt,
      version: payload.version,
      steps: payload.steps,
      clientId: "client-a"
    });

    assert.equal(result.accepted, true);
    const saved = await db.document.findUniqueOrThrow({ where: { id: document.id }, select: { content: true } });
    assert.equal(textFromRawContent(saved.content), "Hello brave new world");
    assert.equal(await durableStepCount(document.id), 1);
  } finally {
    await cleanup(user.id, document.id);
  }
});

test("content and the durable step log advance together (no desync after save)", async () => {
  const { user, document } = await createTestDocument("base");
  try {
    let client = createClientState("base", 0, "client-a");
    // Three separate inserts => three steps in one push.
    client = client.apply(client.tr.insertText("A", 1));
    client = client.apply(client.tr.insertText("B", 1));
    client = client.apply(client.tr.insertText("C", 1));
    const payload = payloadFromState(client);
    assert.equal(payload.steps.length, 3);

    const result = await submitCollaborationSteps({
      documentId: document.id,
      rawContent: document.content,
      currentTitle: document.title,
      currentUpdatedAt: document.updatedAt,
      version: payload.version,
      steps: payload.steps,
      clientId: "client-a"
    });
    assert.equal(result.accepted, true);

    // Durable version (MAX(version)+1) must equal the number of persisted steps,
    // and Document.content must reflect every applied step.
    const durableVersion = await getCollaborationVersion(document.id, document.content, document.updatedAt);
    assert.equal(durableVersion, await durableStepCount(document.id));
    assert.equal(durableVersion, 3);
    const saved = await db.document.findUniqueOrThrow({ where: { id: document.id }, select: { content: true } });
    assert.equal(textFromRawContent(saved.content), "CBAbase");
  } finally {
    await cleanup(user.id, document.id);
  }
});

test("AI-edit versionMeta attaches commit/sources/aiRunId to the post-edit version (save after AI edit)", async () => {
  const { user, document } = await createTestDocument("Original selection text");
  const aiRun = await db.aiRun.create({
    data: { documentId: document.id, triggerType: "SELECTION_EDIT", instruction: "edit it" }
  });
  try {
    let client = createClientState("Original selection text", 0, "ai-client");
    // Simulate the AI edit replacing the paragraph content.
    client = client.apply(client.tr.insertText(" (edited by AI)", client.doc.content.size - 1));
    const payload = payloadFromState(client);

    const result = await submitCollaborationSteps({
      documentId: document.id,
      rawContent: document.content,
      currentTitle: document.title,
      currentUpdatedAt: document.updatedAt,
      version: payload.version,
      steps: payload.steps,
      clientId: "ai-client",
      versionMeta: {
        forceVersion: true,
        sourceLinks: ["https://example.com/source"],
        commitSha: "abc1234",
        commitUrl: "https://github.com/owner/repo/commit/abc1234",
        aiRunId: aiRun.id
      }
    });
    assert.equal(result.accepted, true);

    const saved = await db.document.findUniqueOrThrow({ where: { id: document.id }, select: { content: true } });
    const savedText = textFromRawContent(saved.content);
    assert.match(savedText, /edited by AI/);

    // The version snapshot carrying the new content must record the AI metadata.
    const version = await db.documentVersion.findFirst({
      where: { documentId: document.id, commitSha: "abc1234" },
      orderBy: { createdAt: "desc" }
    });
    assert.ok(version, "expected a version snapshot tagged with the AI commit");
    assert.equal(version.aiRunId, aiRun.id);
    assert.equal(version.commitUrl, "https://github.com/owner/repo/commit/abc1234");
    assert.deepEqual(parseSourceLinks(version.sourceLinks), ["https://example.com/source"]);
    assert.match(textFromRawContent(version.content), /edited by AI/);
  } finally {
    await cleanup(user.id, document.id);
  }
});

test("a malformed step is rejected and leaves content + step log untouched", async () => {
  const { user, document } = await createTestDocument("intact");
  try {
    await assert.rejects(
      submitCollaborationSteps({
        documentId: document.id,
        rawContent: document.content,
        currentTitle: document.title,
        currentUpdatedAt: document.updatedAt,
        version: 0,
        // A step that cannot apply to the doc (replace beyond document bounds).
        steps: [{ stepType: "replace", from: 9999, to: 9999, slice: { content: [{ type: "text", text: "x" }] } }],
        clientId: "bad-client"
      })
    );

    // Nothing should have been persisted.
    assert.equal(await durableStepCount(document.id), 0);
    const saved = await db.document.findUniqueOrThrow({ where: { id: document.id }, select: { content: true } });
    assert.equal(textFromRawContent(saved.content), "intact");
  } finally {
    await cleanup(user.id, document.id);
  }
});
