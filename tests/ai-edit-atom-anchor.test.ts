import assert from "node:assert/strict";
import { test } from "node:test";

import { EditorState } from "@tiptap/pm/state";

import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import {
  createAiEditSelectionPlugin,
  upsertAiEditSelection,
  removeAiEditSelection,
  getAiEditSelectionRange,
  cleanupStaleAiEditRangeMarks,
} from "../components/document-workspace/ai-edit-selections";

const schema = createDocumentEditorSchema();

const DOC = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Before the figure." }] },
    {
      type: "repoImage",
      attrs: {
        src: "/api/documents/x/repo-files?path=assets%2Fsine_wave.svg",
        alt: "Sine wave",
        caption: "Sine wave",
        path: "assets/sine_wave.svg",
      },
    },
    { type: "paragraph", content: [{ type: "text", text: "Question one and two." }] },
  ],
};

function freshState() {
  return EditorState.create({ doc: schema.nodeFromJSON(DOC), plugins: [createAiEditSelectionPlugin()] });
}

function repoImagePos(state: EditorState) {
  let pos = -1;
  state.doc.descendants((node, p) => {
    if (node.type.name === "repoImage") pos = p;
  });
  return pos;
}

// Rebuilds the editor from its serialized JSON with a fresh plugin — what a reload,
// remount, or remote-snapshot during a long agent run does. Selections then survive
// only via anchors that live in the document itself.
function recreate(state: EditorState) {
  return EditorState.create({ doc: schema.nodeFromJSON(state.doc.toJSON()), plugins: [createAiEditSelectionPlugin()] });
}

test("a repoImage (block atom) selection survives an editor rebuild", () => {
  let state = freshState();
  const pos = repoImagePos(state);
  const id = "sel-image";

  state = state.apply(upsertAiEditSelection(state, { id, from: pos, to: pos + 1, progress: "x" }));
  // Live anchor works before any rebuild.
  assert.deepEqual(getAiEditSelectionRange(state, id), { from: pos, to: pos + 1 });

  // After a rebuild the inline mark is gone (atoms can't hold inline marks). Before
  // the fix the selection was unrecoverable here → "The edited range was deleted…".
  const rebuilt = recreate(state);
  const recovered = getAiEditSelectionRange(rebuilt, id);
  assert.ok(recovered, "atom selection must survive the rebuild");
  assert.deepEqual(recovered, { from: pos, to: pos + 1 }, "recovered range must still cover the atom");
});

test("a text selection still survives an editor rebuild (regression)", () => {
  let state = freshState();
  const last = "Question one and two.";
  const from = state.doc.content.size - last.length - 1;
  const id = "sel-text";

  state = state.apply(upsertAiEditSelection(state, { id, from, to: from + 8, progress: "x" }));
  const rebuilt = recreate(state);
  assert.deepEqual(getAiEditSelectionRange(rebuilt, id), { from, to: from + 8 });
});

test("removing an atom selection clears its persisted anchor", () => {
  let state = freshState();
  const pos = repoImagePos(state);
  const id = "sel-image";

  state = state.apply(upsertAiEditSelection(state, { id, from: pos, to: pos + 1, progress: "x" }));
  state = state.apply(removeAiEditSelection(state, id));

  const rebuilt = recreate(state);
  assert.equal(getAiEditSelectionRange(rebuilt, id), null, "anchor must be gone after removal");
  // The repoImage node must carry no leftover selection id.
  let ids: unknown = null;
  rebuilt.doc.descendants((node) => {
    if (node.type.name === "repoImage") ids = node.attrs.aiEditSelectionIds;
  });
  assert.deepEqual(ids ?? [], [], "no stale selection ids on the node");
});

test("cleanupStaleAiEditRangeMarks strips atom anchors for inactive selections", () => {
  let state = freshState();
  const pos = repoImagePos(state);
  state = state.apply(upsertAiEditSelection(state, { id: "stale", from: pos, to: pos + 1, progress: "x" }));

  // Simulate a reload where the "stale" run is no longer active.
  const rebuilt = recreate(state);
  const tr = cleanupStaleAiEditRangeMarks(rebuilt, new Set<string>());
  assert.ok(tr, "cleanup should produce a transaction for the leftover atom anchor");
  const cleaned = rebuilt.apply(tr!);
  assert.equal(getAiEditSelectionRange(cleaned, "stale"), null);
});
