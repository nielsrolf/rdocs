import assert from "node:assert/strict";
import { test } from "node:test";

import { EditorState } from "@tiptap/pm/state";

import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import {
  createAiEditSelectionPlugin,
  getAiEditSelectionRange,
  removeAiEditSelection,
  upsertAiEditSelection,
} from "../components/document-workspace/ai-edit-selections";

const schema = createDocumentEditorSchema();

function freshState() {
  return EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "The quick brown fox jumps over." }] }],
    }),
    plugins: [createAiEditSelectionPlugin()],
  });
}

function recreate(state: EditorState) {
  return EditorState.create({ doc: schema.nodeFromJSON(state.doc.toJSON()), plugins: [createAiEditSelectionPlugin()] });
}

test("two AI selections on OVERLAPPING text both survive an editor rebuild", () => {
  let state = freshState();
  // A covers "quick brown", B covers "brown fox" — they overlap on "brown".
  state = state.apply(upsertAiEditSelection(state, { id: "A", from: 5, to: 16, progress: "x" }));
  state = state.apply(upsertAiEditSelection(state, { id: "B", from: 11, to: 20, progress: "x" }));

  const aBefore = getAiEditSelectionRange(state, "A");
  const bBefore = getAiEditSelectionRange(state, "B");
  assert.deepEqual(aBefore, { from: 5, to: 16 });
  assert.deepEqual(bBefore, { from: 11, to: 20 });

  // After a rebuild the in-memory plugin entries are gone; both selections must be
  // recoverable from the inline marks. Before the array-valued mark fix, B's addMark
  // clobbered A's mark on the overlap, so A was lost here.
  const rebuilt = recreate(state);
  assert.ok(getAiEditSelectionRange(rebuilt, "A"), "A survives (was clobbered before the fix)");
  assert.ok(getAiEditSelectionRange(rebuilt, "B"), "B survives");
  assert.deepEqual(getAiEditSelectionRange(rebuilt, "A"), { from: 5, to: 16 });
  assert.deepEqual(getAiEditSelectionRange(rebuilt, "B"), { from: 11, to: 20 });
});

test("removing one overlapping selection keeps the other anchored", () => {
  let state = freshState();
  state = state.apply(upsertAiEditSelection(state, { id: "A", from: 5, to: 16, progress: "x" }));
  state = state.apply(upsertAiEditSelection(state, { id: "B", from: 11, to: 20, progress: "x" }));

  state = state.apply(removeAiEditSelection(state, "A"));
  assert.equal(getAiEditSelectionRange(state, "A"), null, "A is gone");

  const rebuilt = recreate(state);
  assert.equal(getAiEditSelectionRange(rebuilt, "A"), null, "A stays gone after rebuild");
  assert.deepEqual(getAiEditSelectionRange(rebuilt, "B"), { from: 11, to: 20 }, "B still anchored via its mark");
});
