import assert from "node:assert/strict";
import { test } from "node:test";

import { EditorState } from "@tiptap/pm/state";

import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import {
  createAiEditSelectionPlugin,
  getAiEditSelectionRange,
  reseedAiEditSelectionsFromDoc,
  removeAiEditSelection,
  upsertAiEditSelection,
} from "../components/document-workspace/ai-edit-selections";

const schema = createDocumentEditorSchema();

function freshState() {
  return EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Alpha section text." }] },
        { type: "paragraph", content: [{ type: "text", text: "Bravo section text." }] },
        { type: "paragraph", content: [{ type: "text", text: "Charlie section text." }] },
      ],
    }),
    plugins: [createAiEditSelectionPlugin()],
  });
}

// Reproduces applyAiEditRun's tail: it ends with editor.commands.setContent(snapshot, false)
// to force a node-view remount. setContent is a replace-the-whole-document step.
function setContentRemount(state: EditorState): EditorState {
  const snapshot = state.doc.toJSON();
  const snapDoc = schema.nodeFromJSON(snapshot as never);
  return state.apply(state.tr.replaceWith(0, state.doc.content.size, snapDoc.content));
}

test("setContent remount collapses OTHER pending anchors to the document end", () => {
  let state = freshState();
  // Two AI edits in flight, anchored on different sections.
  state = state.apply(upsertAiEditSelection(state, { id: "A", from: 2, to: 6, progress: "x" })); // in "Alpha"
  state = state.apply(upsertAiEditSelection(state, { id: "B", from: 23, to: 28, progress: "x" })); // in "Bravo"
  const bBefore = getAiEditSelectionRange(state, "B");
  assert.deepEqual(bBefore, { from: 23, to: 28 });
  const bText = state.doc.textBetween(23, 28);

  // Run A applies: drop its own anchor, then remount.
  state = state.apply(removeAiEditSelection(state, "A"));
  state = setContentRemount(state);

  // BUG: B's anchor is now pinned to the document end, so run B would insert its
  // result at the bottom of the doc instead of inside the Bravo section.
  const docEnd = state.doc.content.size;
  const bCollapsed = getAiEditSelectionRange(state, "B");
  assert.deepEqual(bCollapsed, { from: docEnd, to: docEnd }, "precondition: remount collapsed B to the end");

  // FIX: re-seed from the surviving marks restores B's real position.
  const tr = reseedAiEditSelectionsFromDoc(state);
  assert.ok(tr, "reseed should produce a transaction");
  state = state.apply(tr!);
  const bFixed = getAiEditSelectionRange(state, "B");
  assert.ok(bFixed && bFixed.from < docEnd, "B must be re-pinned inside the document, not at the end");
  assert.equal(state.doc.textBetween(bFixed!.from, bFixed!.to), bText, "B points back at its original Bravo text");
});

test("reseed also restores a repoImage (atom) anchor after a remount", () => {
  let state = EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "intro" }] },
        { type: "repoImage", attrs: { src: "/r", alt: "p", caption: "p", path: "assets/p.svg" } },
        { type: "paragraph", content: [{ type: "text", text: "outro" }] },
      ],
    }),
    plugins: [createAiEditSelectionPlugin()],
  });
  let imgPos = -1;
  state.doc.descendants((n, p) => {
    if (n.type.name === "repoImage") imgPos = p;
  });
  state = state.apply(upsertAiEditSelection(state, { id: "img", from: imgPos, to: imgPos + 1, progress: "x" }));
  state = setContentRemount(state);

  const tr = reseedAiEditSelectionsFromDoc(state);
  assert.ok(tr, "atom anchor needs re-seeding too");
  state = state.apply(tr!);
  assert.deepEqual(getAiEditSelectionRange(state, "img"), { from: imgPos, to: imgPos + 1 });
});

test("reseed is a no-op when anchors already match the document", () => {
  let state = freshState();
  state = state.apply(upsertAiEditSelection(state, { id: "A", from: 2, to: 6, progress: "x" }));
  assert.equal(reseedAiEditSelectionsFromDoc(state), null);
});
