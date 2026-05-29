import assert from "node:assert/strict";
import test from "node:test";

import { differsOnlyByCommentAnchors } from "../lib/comment-anchors";
import { documentHasAnchorForThread } from "../lib/content";

// Regression coverage for: "commenting on things (tooltip images, repo images,
// widgets) sometimes failed". Comments on block atoms are anchored by a
// `commentThreadIds` attr (not the inline commentAnchor mark). The orphan guard
// in the comments route uses documentHasAnchorForThread, so if it can't see the
// block-node attr, a legitimate comment on a widget/image is rejected.

function docWith(...nodes: unknown[]) {
  return { type: "doc", content: nodes };
}

test("documentHasAnchorForThread finds an inline commentAnchor mark", () => {
  const doc = docWith({
    type: "paragraph",
    content: [
      { type: "text", text: "Hello", marks: [{ type: "commentAnchor", attrs: { threadId: "t1" } }] },
      { type: "text", text: " world" }
    ]
  });
  assert.equal(documentHasAnchorForThread(doc, "t1"), true);
  assert.equal(documentHasAnchorForThread(doc, "t2"), false);
});

test("documentHasAnchorForThread finds commentThreadIds on a widget block", () => {
  const doc = docWith({
    type: "embeddedWidget",
    attrs: { label: "Explorer", commentThreadIds: ["t-widget"] }
  });
  assert.equal(documentHasAnchorForThread(doc, "t-widget"), true);
  assert.equal(documentHasAnchorForThread(doc, "t-other"), false);
});

test("documentHasAnchorForThread finds commentThreadIds on repoImage and image blocks", () => {
  const repoImageDoc = docWith({ type: "repoImage", attrs: { path: "assets/p.png", commentThreadIds: ["t-img"] } });
  assert.equal(documentHasAnchorForThread(repoImageDoc, "t-img"), true);

  const imageDoc = docWith({ type: "image", attrs: { src: "data:...", commentThreadIds: ["t-pasted"] } });
  assert.equal(documentHasAnchorForThread(imageDoc, "t-pasted"), true);
});

test("documentHasAnchorForThread searches nested content", () => {
  const doc = docWith({
    type: "blockquote",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "x" }] },
      { type: "repoImage", attrs: { commentThreadIds: ["deep"] } }
    ]
  });
  assert.equal(documentHasAnchorForThread(doc, "deep"), true);
});

test("documentHasAnchorForThread returns false when the thread is not anchored", () => {
  const doc = docWith({ type: "paragraph", content: [{ type: "text", text: "no anchors here" }] });
  assert.equal(documentHasAnchorForThread(doc, "missing"), false);
});

test("toggling a comment on a widget block counts as an anchor-only change", () => {
  const withoutComment = docWith({ type: "embeddedWidget", attrs: { label: "Explorer", commentThreadIds: [] } });
  const withComment = docWith({ type: "embeddedWidget", attrs: { label: "Explorer", commentThreadIds: ["t1"] } });
  assert.equal(differsOnlyByCommentAnchors(withoutComment, withComment), true);
});

test("a real change to a block node (e.g. its label) is NOT treated as anchor-only", () => {
  const before = docWith({ type: "embeddedWidget", attrs: { label: "Explorer", commentThreadIds: ["t1"] } });
  const after = docWith({ type: "embeddedWidget", attrs: { label: "Renamed", commentThreadIds: ["t1"] } });
  assert.equal(differsOnlyByCommentAnchors(before, after), false);
});
