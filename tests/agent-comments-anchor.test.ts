import assert from "node:assert/strict";
import { test } from "node:test";

import { EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import { flattenDocumentTextNodes } from "../lib/suggestion-content";
import { validateAgentComments } from "../lib/ai-edit-submission";
import { resolveSuggestionRange } from "../components/document-workspace/ai-suggestions";
import { buildCommentAnchorTransaction } from "../components/document-workspace/comment-anchors";

const schema = createDocumentEditorSchema();

const SAMPLE = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Project Plan" }] },
    { type: "paragraph", content: [{ type: "text", text: "The timeline is aggressive but achievable." }] }
  ]
};

test("an agent comment anchor that passes validation resolves and anchors a commentAnchor mark", () => {
  const anchorBasis = flattenDocumentTextNodes(SAMPLE);
  const comment = { findText: "aggressive but achievable", body: "Is this realistic?" };
  // Server-side validation passes.
  assert.equal(validateAgentComments([comment], anchorBasis), null);

  // Client resolves the anchor and places the commentAnchor mark for the thread.
  const state = EditorState.create({ doc: schema.nodeFromJSON(SAMPLE) });
  const range = resolveSuggestionRange(state.doc, comment.findText);
  assert.ok(range, "anchor resolves on the client");

  const tr = buildCommentAnchorTransaction(state, range!, "thread-123");
  assert.ok(tr, "comment anchor transaction is built");
  const next = state.apply(tr!);

  let anchored = false;
  next.doc.descendants((node: PMNode) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "commentAnchor");
    if (mark && mark.attrs.threadId === "thread-123" && node.text && "aggressive but achievable".includes(node.text)) {
      anchored = true;
    }
  });
  assert.ok(anchored, "the resolved range carries the commentAnchor mark for the agent's thread");
});
