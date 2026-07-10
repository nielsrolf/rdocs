import assert from "node:assert/strict";
import { test } from "node:test";

import { AllSelection, EditorState, NodeSelection } from "@tiptap/pm/state";

import {
  buildCommentAnchorTransaction,
  collectCommentAnchorRanges,
  resolveCommentAnchorRange
} from "../components/document-workspace/comment-anchors";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";

// Regression coverage for the two "select all + mixed content" comment bugs:
//   1. Commenting on a select-all spanning text, images, and a widget failed
//      ("Unable to anchor the comment to the selected text") and/or anchored
//      only the text, leaving the image/widget uncovered.
//   2. After select-all + delete, comments anchored on widgets/repoImages
//      lingered instead of disappearing like deleted-text comments.

const schema = createDocumentEditorSchema();

const MIXED_DOC = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Hello world" }] },
    { type: "image", attrs: { src: "data:image/png;base64,xx" } },
    { type: "embeddedWidget", attrs: { label: "Explorer" } },
    { type: "repoImage", attrs: { path: "assets/p.png", alt: "P" } },
    { type: "paragraph", content: [{ type: "text", text: "Tail" }] }
  ]
};

function stateFrom(docJson: unknown) {
  return EditorState.create({ doc: schema.nodeFromJSON(docJson) });
}

function anchorsInDoc(doc: ReturnType<typeof schema.nodeFromJSON>, threadId: string) {
  const found = { text: false, image: false, widget: false, repoImage: false };
  doc.descendants((node) => {
    if (
      node.isText &&
      node.marks.some((mark) => mark.type.name === "commentAnchor" && mark.attrs.threadId === threadId)
    ) {
      found.text = true;
    }
    const ids = Array.isArray(node.attrs?.commentThreadIds)
      ? (node.attrs.commentThreadIds as string[])
      : [];
    if (node.type.name === "image" && ids.includes(threadId)) found.image = true;
    if (node.type.name === "embeddedWidget" && ids.includes(threadId)) found.widget = true;
    if (node.type.name === "repoImage" && ids.includes(threadId)) found.repoImage = true;
    return true;
  });
  return found;
}

test("select-all over text + image + widget + repoImage anchors all of them", () => {
  const state = stateFrom(MIXED_DOC);
  const all = new AllSelection(state.doc);
  const tr = buildCommentAnchorTransaction(state, { from: all.from, to: all.to }, "t-all");

  assert.ok(tr, "a select-all over mixed content must produce an anchor transaction");
  const found = anchorsInDoc(tr!.doc, "t-all");
  assert.deepEqual(found, { text: true, image: true, widget: true, repoImage: true });

  // The thread resolves to a single range spanning the selection.
  const range = collectCommentAnchorRanges(tr!.doc).get("t-all");
  assert.ok(range, "the anchored thread must resolve to a range");
});

test("a selection containing only block atoms (no text) still anchors", () => {
  const state = stateFrom(MIXED_DOC);
  let imagePos = -1;
  let repoImagePos = -1;
  state.doc.descendants((node, pos) => {
    if (node.type.name === "image") imagePos = pos;
    if (node.type.name === "repoImage") repoImagePos = pos;
  });
  // Spans image..repoImage (image, widget, repoImage) — no text in range.
  const tr = buildCommentAnchorTransaction(
    state,
    { from: imagePos, to: repoImagePos + 1 },
    "t-atoms"
  );

  assert.ok(tr, "anchoring a selection of only atoms must succeed (used to error)");
  const found = anchorsInDoc(tr!.doc, "t-atoms");
  assert.equal(found.text, false);
  assert.equal(found.image, true);
  assert.equal(found.widget, true);
  assert.equal(found.repoImage, true);
});

test("a single-widget NodeSelection anchors just that widget (regression)", () => {
  const state = stateFrom(MIXED_DOC);
  let widgetPos = -1;
  state.doc.descendants((node, pos) => {
    if (node.type.name === "embeddedWidget") widgetPos = pos;
  });
  const withSelection = state.apply(
    state.tr.setSelection(NodeSelection.create(state.doc, widgetPos))
  );
  const tr = buildCommentAnchorTransaction(
    withSelection,
    { from: widgetPos, to: widgetPos + 1 },
    "t-widget"
  );

  assert.ok(tr);
  const found = anchorsInDoc(tr!.doc, "t-widget");
  assert.deepEqual(found, { text: false, image: false, widget: true, repoImage: false });
});

test("an existing thread id on a block atom is not duplicated", () => {
  const state = stateFrom({
    type: "doc",
    content: [{ type: "embeddedWidget", attrs: { label: "W", commentThreadIds: ["t-existing"] } }]
  });
  const tr = buildCommentAnchorTransaction(state, { from: 0, to: 1 }, "t-existing");
  assert.ok(tr);
  let ids: string[] = [];
  tr!.doc.descendants((node) => {
    if (node.type.name === "embeddedWidget") ids = node.attrs.commentThreadIds as string[];
  });
  assert.deepEqual(ids, ["t-existing"], "no duplicate thread id on the widget");
});

test("a selection with nothing anchorable returns null (real error surfaced)", () => {
  const state = stateFrom({ type: "doc", content: [{ type: "paragraph" }] });
  // Empty paragraph: from/to both at the cursor inside it — no text, no atoms.
  const tr = buildCommentAnchorTransaction(state, { from: 1, to: 1 }, "t-empty");
  assert.equal(tr, null);
});

test("deleting an anchored widget orphans its thread, just like deleted text", () => {
  // Anchor a comment on a widget and on text, then 'select all + delete'.
  const state = stateFrom(MIXED_DOC);
  const all = new AllSelection(state.doc);
  const anchored = state.apply(
    buildCommentAnchorTransaction(state, { from: all.from, to: all.to }, "t-doomed")!
  );

  // Both block-atom and text anchors resolve while the content exists.
  assert.ok(resolveCommentAnchorRange(anchored.doc, { id: "t-doomed" } as never));

  // Replace the whole document with an empty paragraph (what select-all + delete does).
  const emptyDoc = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph" }] });
  const deleted = anchored.apply(
    anchored.tr.replaceWith(0, anchored.doc.content.size, emptyDoc.content)
  );

  // No anchor remains, so visibleThreads will now hide the orphaned thread —
  // for the widget/repoImage exactly as for the deleted text.
  assert.equal(resolveCommentAnchorRange(deleted.doc, { id: "t-doomed" } as never), null);
});
