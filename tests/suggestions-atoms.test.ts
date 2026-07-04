import assert from "node:assert/strict";
import { test } from "node:test";

import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { Fragment } from "@tiptap/pm/model";
import type { Node as PMNode } from "@tiptap/pm/model";

import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import {
  buildDeletionSuggestion,
  collectSuggestionRanges,
  createSuggestionPlugin,
  resolveDeletionRange,
  setSuggestionMode
} from "../components/document-workspace/suggestions";
import { SUGGESTION_INSERT_RECORDS_ATTR, SUGGESTION_DELETE_RECORDS_ATTR } from "../lib/suggestion-content";

const schema = createDocumentEditorSchema();
const AUTHOR = { authorId: "u1", authorLabel: "Alice" };

// A doc with a paragraph, an image atom, and another paragraph.
function docWithImage() {
  return EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Before" }] },
        { type: "image", attrs: { src: "data:image/png;base64,xxx", alt: "pic" } },
        { type: "paragraph", content: [{ type: "text", text: "After" }] }
      ]
    }),
    plugins: [createSuggestionPlugin()]
  });
}

function enable(state: EditorState) {
  return state.apply(setSuggestionMode(state, true, AUTHOR));
}

function atomRecords(doc: PMNode, attr: string) {
  const out: unknown[] = [];
  doc.descendants((node) => {
    const recs = node.attrs?.[attr];
    if (Array.isArray(recs) && recs.length > 0) out.push(...recs);
  });
  return out;
}

test("inserting an image atom in suggesting mode marks it as a suggested insertion", () => {
  let state = enable(
    EditorState.create({
      doc: schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph" }] }),
      plugins: [createSuggestionPlugin()]
    })
  );
  const image = schema.nodes.image.create({ src: "data:image/png;base64,xxx", alt: "pic" });
  state = state.apply(state.tr.insert(state.doc.content.size, Fragment.from(image)));

  assert.equal(atomRecords(state.doc, SUGGESTION_INSERT_RECORDS_ATTR).length, 1);
  const ranges = collectSuggestionRanges(state.doc);
  assert.equal(ranges.filter((r) => r.kind === "insert").length, 1);
});

test("deleting a selected image atom marks it as a suggested deletion (node preserved)", () => {
  let state = enable(docWithImage());
  // Select the image node (it sits right after the first paragraph).
  let imagePos = -1;
  state.doc.descendants((node, pos) => {
    if (node.type.name === "image") imagePos = pos;
  });
  assert.ok(imagePos >= 0);
  state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, imagePos)));

  const range = resolveDeletionRange(state, "backward");
  assert.ok(range);
  const tr = buildDeletionSuggestion(state, range!, AUTHOR, "backward");
  assert.ok(tr, "atom deletion should produce a suggestion transaction");
  state = state.apply(tr!);

  // The image node is still present, now flagged for deletion.
  let stillHasImage = false;
  state.doc.descendants((node) => {
    if (node.type.name === "image") stillHasImage = true;
  });
  assert.ok(stillHasImage, "image preserved until accepted");
  assert.equal(atomRecords(state.doc, SUGGESTION_DELETE_RECORDS_ATTR).length, 1);
});

test("backspacing with the caret just after an image targets the image (atom adjacency)", () => {
  let state = enable(docWithImage());
  // Place the caret at the very start of the "After" paragraph (parentOffset 0),
  // i.e. immediately after the image. Today resolveDeletionRange returns null here.
  let afterParaStart = -1;
  state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" && node.textContent === "After") afterParaStart = pos + 1;
  });
  assert.ok(afterParaStart >= 0);
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, afterParaStart)));

  const range = resolveDeletionRange(state, "backward");
  // Desired behavior: the range should cover the preceding image atom.
  assert.ok(range, "backspacing after an image should target the image, not fall through");
});
