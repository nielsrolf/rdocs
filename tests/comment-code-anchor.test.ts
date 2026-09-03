import assert from "node:assert/strict";
import { test } from "node:test";

import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";

import { CommentAnchor, buildCommentAnchorTransaction } from "../components/document-workspace/comment-anchors";
import { documentHasAnchorForThread } from "../lib/content";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";

// Regression: commenting on inline-code text ("the `print` hack") failed with
// "Anchor not yet saved. Please retry in a moment." ×3. TipTap's Code mark is
// declared with `excludes: "_"`, so the commentAnchor mark was silently dropped
// when added over code text — on the client AND when the server replayed the
// (accepted, no-op) collab step — so the anchor never existed and the comments
// route kept answering 409. Inline code must let annotation marks coexist, and
// the client must notice when an anchor did not land instead of pushing a no-op.

const schema = createDocumentEditorSchema();

const CODE_DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "After the " },
        { type: "text", text: "print", marks: [{ type: "code" }] },
        { type: "text", text: " hack is found" }
      ]
    }
  ]
};

// "print" spans positions 11..16 (paragraph opens at 0, text starts at 1).
const CODE_RANGE = { from: 11, to: 16 };

test("a comment anchor lands on inline-code text", () => {
  const state = EditorState.create({ doc: schema.nodeFromJSON(CODE_DOC) });
  const tr = buildCommentAnchorTransaction(state, CODE_RANGE, "t-code");
  assert.ok(tr, "anchor transaction should be produced");
  assert.equal(documentHasAnchorForThread(tr.doc.toJSON(), "t-code"), true);
  // The code formatting itself must survive.
  const marks = tr.doc.nodeAt(CODE_RANGE.from)?.marks.map((m) => m.type.name).sort();
  assert.deepEqual(marks, ["code", "commentAnchor"]);
});

test("the server replay of an addMark commentAnchor step over code text keeps the anchor", () => {
  const doc = schema.nodeFromJSON(CODE_DOC);
  const step = Step.fromJSON(schema, {
    stepType: "addMark",
    mark: { type: "commentAnchor", attrs: { threadId: "t-step" } },
    from: CODE_RANGE.from,
    to: CODE_RANGE.to
  });
  const result = step.apply(doc);
  assert.equal(result.failed, null);
  assert.equal(documentHasAnchorForThread(result.doc!.toJSON(), "t-step"), true);
});

test("tracked-change suggestion marks coexist with inline code", () => {
  const doc = schema.nodeFromJSON(CODE_DOC);
  const tr = EditorState.create({ doc }).tr.addMark(
    CODE_RANGE.from,
    CODE_RANGE.to,
    schema.marks.suggestedDeletion.create({ suggestionId: "s1" })
  );
  const marks = tr.doc.nodeAt(CODE_RANGE.from)?.marks.map((m) => m.type.name).sort();
  assert.deepEqual(marks, ["code", "suggestedDeletion"]);
});

test("inline code still rejects formatting marks", () => {
  const doc = schema.nodeFromJSON(CODE_DOC);
  const tr = EditorState.create({ doc }).tr.addMark(CODE_RANGE.from, CODE_RANGE.to, schema.marks.bold.create());
  const marks = tr.doc.nodeAt(CODE_RANGE.from)?.marks.map((m) => m.type.name);
  assert.deepEqual(marks, ["code"]);
});

test("buildCommentAnchorTransaction returns null when the anchor mark cannot land", () => {
  // A schema whose code mark excludes everything (TipTap's default) reproduces the
  // silent drop; the client must surface a real error instead of pushing a no-op.
  const strictSchema = getSchema([StarterKit, CommentAnchor]);
  const state = EditorState.create({ doc: strictSchema.nodeFromJSON(CODE_DOC) });
  const tr = buildCommentAnchorTransaction(state, CODE_RANGE, "t-strict");
  assert.equal(tr === null, true, "no anchor transaction should be produced when the mark is excluded");
});
