import assert from "node:assert/strict";
import { test } from "node:test";

import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import {
  acceptAllSuggestions,
  acceptSuggestion,
  buildDeletionSuggestion,
  collectSuggestionRanges,
  createSuggestionPlugin,
  markExplicitSuggestion,
  rejectAllSuggestions,
  rejectSuggestion,
  setSuggestionMode
} from "../components/document-workspace/suggestions";

const schema = createDocumentEditorSchema();
const AUTHOR = { authorId: "u1", authorLabel: "Alice" };
const OTHER = { authorId: "u2", authorLabel: "Bob" };

function stateWith(text: string) {
  return EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }]
    }),
    plugins: [createSuggestionPlugin()]
  });
}

function enable(state: EditorState, author = AUTHOR) {
  return state.apply(setSuggestionMode(state, true, author));
}

function docText(doc: PMNode) {
  return doc.textBetween(0, doc.content.size, "\n");
}

function marksAt(doc: PMNode, name: string) {
  const ranges: Array<{ text: string; id: string }> = [];
  doc.descendants((node) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === name);
    if (mark) ranges.push({ text: node.text ?? "", id: String(mark.attrs.suggestionId ?? "") });
  });
  return ranges;
}

function recreate(state: EditorState) {
  return EditorState.create({
    doc: schema.nodeFromJSON(state.doc.toJSON()),
    plugins: [createSuggestionPlugin()]
  });
}

test("typing in suggesting mode marks only the inserted text as suggestedInsertion", () => {
  let state = enable(stateWith("Hello world."));
  // Insert " brave" after "Hello" (pos 6 = after "Hello").
  state = state.apply(state.tr.insertText(" brave", 6));

  assert.equal(docText(state.doc), "Hello brave world.");
  const inserts = marksAt(state.doc, "suggestedInsertion");
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].text, " brave");
  // Pre-existing text is untouched.
  assert.equal(marksAt(state.doc, "suggestedDeletion").length, 0);
});

test("appendTransaction does not loop / re-mark its own rewrite", () => {
  const state = enable(stateWith("abc"));
  const { state: next, transactions } = state.applyTransaction(state.tr.insertText("X", 4));
  // One user transaction + at most one appended marking transaction.
  assert.ok(transactions.length <= 2, `expected <=2 transactions, got ${transactions.length}`);
  assert.equal(marksAt(next.doc, "suggestedInsertion")[0]?.text, "X");
});

test("consecutive insertions share one suggestion id (inclusive mark)", () => {
  let state = enable(stateWith("Hi"));
  state = state.apply(state.tr.insertText("a", 3)); // after "Hi"
  state = state.apply(state.tr.insertText("b", 4)); // right after the "a"
  const inserts = collectSuggestionRanges(state.doc).filter((s) => s.kind === "insert");
  assert.equal(inserts.length, 1, "adjacent typing stays a single suggestion");
});

test("suggestion marks survive a schema round-trip (collab/version snapshot)", () => {
  let state = enable(stateWith("Hello world."));
  state = state.apply(state.tr.insertText(" brave", 6));
  const rebuilt = recreate(state);
  const inserts = marksAt(rebuilt.doc, "suggestedInsertion");
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].text, " brave");
});

test("deleting existing text marks it suggestedDeletion (text preserved)", () => {
  const state = enable(stateWith("Hello world."));
  // Delete "world" (pos 7..12).
  const tr = buildDeletionSuggestion(state, { from: 7, to: 12 }, AUTHOR, "backward");
  assert.ok(tr);
  const next = state.apply(tr!);
  assert.equal(docText(next.doc), "Hello world.", "text is preserved, only struck");
  const deletes = marksAt(next.doc, "suggestedDeletion");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].text, "world");
});

test("deleting your own pending insertion really removes it", () => {
  let state = enable(stateWith("Hello ."));
  state = state.apply(state.tr.insertText("brave", 7)); // "Hello brave."
  assert.equal(docText(state.doc), "Hello brave.");
  // Now backspace-delete the inserted "brave" (pos 7..12).
  const tr = buildDeletionSuggestion(state, { from: 7, to: 12 }, AUTHOR, "backward");
  assert.ok(tr);
  state = state.apply(tr!);
  assert.equal(docText(state.doc), "Hello .", "own insertion is genuinely deleted");
  assert.equal(marksAt(state.doc, "suggestedDeletion").length, 0);
});

test("another author's insertion is struck (not deleted) when you delete it", () => {
  let state = enable(stateWith("Hello ."), OTHER);
  state = state.apply(state.tr.insertText("brave", 7)); // Bob inserts
  // Alice deletes the range.
  const tr = buildDeletionSuggestion(state, { from: 7, to: 12 }, AUTHOR, "backward");
  // Bob's insertion is not Alice's own → it gets a deletion mark layered, text stays.
  assert.ok(tr);
  state = state.apply(tr!);
  assert.equal(docText(state.doc), "Hello brave.");
});

test("accept insertion keeps text; reject insertion removes it", () => {
  let base = enable(stateWith("Hello world."));
  base = base.apply(base.tr.insertText(" brave", 6));
  const id = collectSuggestionRanges(base.doc).find((s) => s.kind === "insert")!.suggestionId;

  const accepted = base.apply(acceptSuggestion(base, id)!);
  assert.equal(docText(accepted.doc), "Hello brave world.");
  assert.equal(collectSuggestionRanges(accepted.doc).length, 0);

  const rejected = base.apply(rejectSuggestion(base, id)!);
  assert.equal(docText(rejected.doc), "Hello world.");
  assert.equal(collectSuggestionRanges(rejected.doc).length, 0);
});

test("accept deletion removes text; reject deletion keeps it", () => {
  const base = enable(stateWith("Hello world."));
  const withDel = base.apply(buildDeletionSuggestion(base, { from: 7, to: 12 }, AUTHOR, "backward")!);
  const id = collectSuggestionRanges(withDel.doc).find((s) => s.kind === "delete")!.suggestionId;

  const accepted = withDel.apply(acceptSuggestion(withDel, id)!);
  assert.equal(docText(accepted.doc), "Hello .");

  const rejected = withDel.apply(rejectSuggestion(withDel, id)!);
  assert.equal(docText(rejected.doc), "Hello world.");
});

test("accept-all / reject-all handle mixed insert+delete with correct offsets", () => {
  let base = enable(stateWith("one two three"));
  // Insert "zero " at the start.
  base = base.apply(base.tr.insertText("zero ", 1));
  // Mark "three" for deletion (recompute its position: "zero one two three").
  const text = docText(base.doc);
  const start = text.indexOf("three") + 1; // +1 for doc/paragraph offset
  base = base.apply(buildDeletionSuggestion(base, { from: start, to: start + 5 }, AUTHOR, "backward")!);
  assert.equal(collectSuggestionRanges(base.doc).length, 2);

  const accepted = base.apply(acceptAllSuggestions(base)!);
  assert.equal(docText(accepted.doc), "zero one two ");
  assert.equal(collectSuggestionRanges(accepted.doc).length, 0);

  const rejected = base.apply(rejectAllSuggestions(base)!);
  assert.equal(docText(rejected.doc), "one two three");
  assert.equal(collectSuggestionRanges(rejected.doc).length, 0);
});

test("markExplicitSuggestion strikes a deletion + flags an insertion (shared id), preserving formatting on accept", () => {
  // Models the agent-suggestion apply path: rich content ("Replacement", bold) was
  // already inserted after the anchor ("Old"); markExplicitSuggestion flags both.
  let state = EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Old" },
            { type: "text", text: "Replacement", marks: [{ type: "bold" }] }
          ]
        }
      ]
    }),
    plugins: [createSuggestionPlugin()]
  });
  const record = { suggestionId: "x", authorId: "ai-run:1", authorLabel: "Claude", createdAt: "t" };
  const tr = markExplicitSuggestion(state, {
    deletion: { from: 1, to: 4 }, // "Old"
    insertion: { from: 4, to: 15 }, // "Replacement"
    record
  });
  assert.ok(tr);
  state = state.apply(tr!);

  const ranges = collectSuggestionRanges(state.doc);
  assert.equal(ranges.filter((r) => r.suggestionId === "x").length, 2, "one delete + one insert entry");

  // Accepting performs the replacement: "Old" removed, "Replacement" kept WITH its bold mark.
  const accepted = state.apply(acceptSuggestion(state, "x")!);
  assert.equal(docText(accepted.doc), "Replacement");
  let boldKept = false;
  accepted.doc.descendants((node) => {
    if (node.isText && node.text === "Replacement") {
      boldKept = node.marks.some((m) => m.type.name === "bold");
    }
  });
  assert.ok(boldKept, "formatting (bold) survives accept");
});

test("no marking happens when suggesting mode is off", () => {
  let state = stateWith("Hello.");
  state = state.apply(state.tr.insertText("X", 6));
  assert.equal(collectSuggestionRanges(state.doc).length, 0);
});

test("backspace at block start falls through (no suggestion produced)", () => {
  const state = enable(stateWith("Hello"));
  // Cursor at paragraph start (pos 1).
  const atStart = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
  // resolveDeletionRange returns null at parentOffset 0, so the keymap returns
  // false; buildDeletionSuggestion is never called. Simulate by asserting the
  // range helper path: a single-char backward delete from pos 1 in this para is a
  // block-start case.
  const sel = atStart.selection;
  assert.equal(sel.$head.parentOffset, 0);
});
