import assert from "node:assert/strict";
import test from "node:test";

import { collab, sendableSteps } from "@tiptap/pm/collab";
import { EditorState } from "@tiptap/pm/state";

import { serializeDocumentContent } from "../lib/content";
import {
  getCollaborationVersion,
  mergeCommitDocument,
  submitCollaborationSteps
} from "../lib/collaboration";
import { db } from "../lib/db";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";

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

async function createTestDocument(initialText: string) {
  const user = await db.user.create({
    data: {
      email: `merge-${crypto.randomUUID()}@example.com`,
      name: "Merge Test",
      passwordHash: "test"
    }
  });
  const document = await db.document.create({
    data: {
      title: "Merge commit test",
      content: serializeDocumentContent(contentWithText(initialText)),
      ownerId: user.id
    }
  });
  return { user, document };
}

async function cleanup(userId: string, documentId: string) {
  await db.$executeRawUnsafe("DELETE FROM CollaborationStep WHERE documentId = ?", documentId).catch(() => undefined);
  await db.documentVersion.deleteMany({ where: { documentId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
}

// Advance the durable version by pushing one real step, so the server is at a
// version > 0 (the realistic merge-commit case).
async function advanceServerByOneStep(document: { id: string; content: string; title: string; updatedAt: Date }) {
  let state = EditorState.create({
    doc: schema.nodeFromJSON(JSON.parse(document.content)),
    plugins: [collab({ version: 0, clientID: "seed" })]
  });
  state = state.apply(state.tr.insertText("X", 1));
  const sendable = sendableSteps(state)!;
  const result = await submitCollaborationSteps({
    documentId: document.id,
    rawContent: document.content,
    currentTitle: document.title,
    currentUpdatedAt: document.updatedAt,
    version: sendable.version,
    steps: sendable.steps.map((s) => s.toJSON()),
    clientId: "seed"
  });
  assert.equal(result.accepted, true);
  return result.version; // new durable version
}

test("merge commit overwrites content, advances version, and archives a snapshot", async () => {
  const { user, document } = await createTestDocument("hello");
  try {
    const baseVersion = await advanceServerByOneStep(document);

    const snapshotsBefore = await db.documentVersion.count({ where: { documentId: document.id } });

    const merged = contentWithText("MERGED RESULT");
    const result = await mergeCommitDocument({
      documentId: document.id,
      clientId: "resolver",
      baseVersion,
      content: merged
    });

    assert.deepEqual(result, { committed: true, version: baseVersion + 1, updatedAt: result.committed ? result.updatedAt : null });

    const saved = await db.document.findUniqueOrThrow({
      where: { id: document.id },
      select: { content: true }
    });
    assert.equal(textFromRawContent(saved.content), "MERGED RESULT");

    // Durable version advanced by exactly one (the synthetic whole-doc step).
    const version = await getCollaborationVersion(document.id, saved.content, new Date());
    assert.equal(version, baseVersion + 1);

    // The overwritten state was archived to version history.
    const snapshotsAfter = await db.documentVersion.count({ where: { documentId: document.id } });
    assert.ok(snapshotsAfter > snapshotsBefore, "expected a version snapshot to be archived");
  } finally {
    await cleanup(user.id, document.id);
  }
});

test("merge commit with a stale baseVersion is refused (no overwrite)", async () => {
  const { user, document } = await createTestDocument("hello");
  try {
    const baseVersion = await advanceServerByOneStep(document);

    const reloaded = await db.document.findUniqueOrThrow({
      where: { id: document.id },
      select: { content: true }
    });
    const contentBefore = reloaded.content;

    const result = await mergeCommitDocument({
      documentId: document.id,
      clientId: "resolver",
      baseVersion: baseVersion - 1, // stale: server already moved past this
      content: contentWithText("SHOULD NOT LAND")
    });

    assert.equal(result.committed, false);
    if (!result.committed) {
      assert.equal(result.reason, "stale");
      assert.equal(result.version, baseVersion);
    }

    const after = await db.document.findUniqueOrThrow({
      where: { id: document.id },
      select: { content: true }
    });
    assert.equal(after.content, contentBefore, "content must be untouched on a stale merge");
  } finally {
    await cleanup(user.id, document.id);
  }
});

test("merge commit rejects content that violates the schema", async () => {
  const { user, document } = await createTestDocument("hello");
  try {
    const baseVersion = await advanceServerByOneStep(document);
    await assert.rejects(
      mergeCommitDocument({
        documentId: document.id,
        clientId: "resolver",
        baseVersion,
        content: { type: "doc", content: [{ type: "totallyUnknownNode" }] }
      }),
      /Invalid merge content|Unknown node type|totallyUnknownNode/
    );
  } finally {
    await cleanup(user.id, document.id);
  }
});
