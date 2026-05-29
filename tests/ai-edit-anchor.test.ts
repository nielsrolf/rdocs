import assert from "node:assert/strict";
import test from "node:test";

import { EditorState } from "@tiptap/pm/state";

import {
  createAiEditSelectionPlugin,
  getAiEditSelectionRange,
  removeAiEditSelection,
  upsertAiEditSelection
} from "../components/document-workspace/ai-edit-selections";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";

// Regression coverage for the marker-loss class: "AI edits sometimes failed to
// update the content." The AI-edit selection is anchored by a plugin-tracked
// position that is rebased through every transaction (local + remote collab
// steps). It must survive concurrent edits, and — critically — when a concurrent
// edit DELETES the selected text it must collapse to a recoverable zero-width
// anchor point rather than vanish (which forced "replacement skipped").

const schema = createDocumentEditorSchema();

function stateWithText(text: string) {
  return EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }]
    }),
    plugins: [createAiEditSelectionPlugin()]
  });
}

test("a selection range is tracked and retrievable by id", () => {
  let state = stateWithText("Hello brave world");
  state = state.apply(upsertAiEditSelection(state, { id: "sel-1", from: 7, to: 12 }));
  assert.deepEqual(getAiEditSelectionRange(state, "sel-1"), { from: 7, to: 12 });
});

test("the range shifts when text is inserted in an earlier section", () => {
  let state = stateWithText("Hello brave world");
  state = state.apply(upsertAiEditSelection(state, { id: "sel-1", from: 7, to: 12 }));
  // Insert 4 chars at position 1 (before the selection).
  state = state.apply(state.tr.insertText("XXXX", 1));
  assert.deepEqual(getAiEditSelectionRange(state, "sel-1"), { from: 11, to: 16 });
});

test("the range is unaffected by edits after it", () => {
  let state = stateWithText("Hello brave world");
  state = state.apply(upsertAiEditSelection(state, { id: "sel-1", from: 7, to: 12 }));
  state = state.apply(state.tr.insertText("!!!", state.doc.content.size - 1));
  assert.deepEqual(getAiEditSelectionRange(state, "sel-1"), { from: 7, to: 12 });
});

test("deleting the selected text collapses to a recoverable anchor point (not lost)", () => {
  let state = stateWithText("Hello brave world");
  state = state.apply(upsertAiEditSelection(state, { id: "sel-1", from: 7, to: 12 }));
  // A concurrent edit deletes "brave " (positions 7..13).
  state = state.apply(state.tr.delete(7, 13));
  const range = getAiEditSelectionRange(state, "sel-1");
  assert.ok(range, "anchor must survive as a zero-width point, not become null");
  assert.equal(range!.from, range!.to, "collapsed to an insertion point");
  assert.equal(range!.from, 7);
});

test("removeAiEditSelection clears the anchor", () => {
  let state = stateWithText("Hello brave world");
  state = state.apply(upsertAiEditSelection(state, { id: "sel-1", from: 7, to: 12 }));
  state = state.apply(removeAiEditSelection(state, "sel-1"));
  assert.equal(getAiEditSelectionRange(state, "sel-1"), null);
});

test("multiple independent selections are tracked separately", () => {
  let state = stateWithText("Hello brave world");
  state = state.apply(upsertAiEditSelection(state, { id: "a", from: 1, to: 6 }));
  state = state.apply(upsertAiEditSelection(state, { id: "b", from: 7, to: 12 }));
  // Insert before both.
  state = state.apply(state.tr.insertText("ZZ", 1));
  assert.deepEqual(getAiEditSelectionRange(state, "a"), { from: 3, to: 8 });
  assert.deepEqual(getAiEditSelectionRange(state, "b"), { from: 9, to: 14 });
});
