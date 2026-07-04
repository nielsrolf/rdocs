import assert from "node:assert/strict";
import { test } from "node:test";

import { EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import { flattenDocumentTextNodes } from "../lib/suggestion-content";
import { validateSuggestions } from "../lib/ai-edit-submission";
import {
  buildAiSuggestionsTransaction,
  resolveSuggestionRange
} from "../components/document-workspace/ai-suggestions";
import { collectSuggestionRanges, createSuggestionPlugin } from "../components/document-workspace/suggestions";

const schema = createDocumentEditorSchema();
const AUTHOR = { authorId: "ai-run:r1", authorLabel: "Claude Opus 4.8" };

function stateFrom(json: unknown) {
  return EditorState.create({
    doc: schema.nodeFromJSON(json),
    plugins: [createSuggestionPlugin()]
  });
}

function docText(doc: PMNode) {
  return doc.textBetween(0, doc.content.size, "\n");
}

const SAMPLE = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "The quick brown fox." }] },
    { type: "paragraph", content: [{ type: "text", text: "It jumps over the lazy dog." }] }
  ]
};

test("resolveSuggestionRange finds a unique anchor and maps it to a doc range", () => {
  const state = stateFrom(SAMPLE);
  const range = resolveSuggestionRange(state.doc, "lazy dog");
  assert.ok(range);
  assert.equal(state.doc.textBetween(range!.from, range!.to), "lazy dog");
});

test("resolveSuggestionRange returns null for missing or non-unique anchors", () => {
  const state = stateFrom(SAMPLE);
  assert.equal(resolveSuggestionRange(state.doc, "elephant"), null);
  // "the" appears in "the lazy" only once lowercase; use "o" which repeats.
  assert.equal(resolveSuggestionRange(state.doc, "o"), null);
});

test("text-space parity: what passes server validation resolves to exactly one client range", () => {
  // The server validates against flattenDocumentTextNodes(content); the client
  // resolves against the same basis built from the editor doc.
  const anchorText = flattenDocumentTextNodes(SAMPLE);
  const suggestion = { findText: "quick brown", replacementText: "swift red" };
  assert.equal(validateSuggestions([suggestion], anchorText), null);

  const state = stateFrom(SAMPLE);
  const range = resolveSuggestionRange(state.doc, suggestion.findText);
  assert.ok(range, "an anchor that passes validation must resolve on the client");
});

test("buildAiSuggestionsTransaction strikes the anchor and inserts the replacement, preserving original text", () => {
  const state = stateFrom(SAMPLE);
  const { tr, applied, skipped } = buildAiSuggestionsTransaction(
    state,
    [
      { findText: "lazy dog", replacementText: "sleepy hound" },
      { findText: "quick brown", replacementText: "swift red" }
    ],
    AUTHOR
  );
  assert.equal(applied, 2);
  assert.equal(skipped.length, 0);
  const next = state.apply(tr!);

  // Original anchored text is preserved (struck, not deleted); replacements added.
  const text = docText(next.doc);
  assert.ok(text.includes("lazy dog"));
  assert.ok(text.includes("sleepy hound"));
  assert.ok(text.includes("quick brown"));
  assert.ok(text.includes("swift red"));

  const ranges = collectSuggestionRanges(next.doc);
  const inserts = ranges.filter((r) => r.kind === "insert");
  const deletes = ranges.filter((r) => r.kind === "delete");
  assert.equal(inserts.length, 2);
  assert.equal(deletes.length, 2);
  // Author attribution flows onto the marks.
  assert.ok(ranges.every((r) => r.author.authorId === "ai-run:r1"));
});

test("buildAiSuggestionsTransaction reports unresolved anchors instead of applying them", () => {
  const state = stateFrom(SAMPLE);
  const { applied, skipped } = buildAiSuggestionsTransaction(
    state,
    [{ findText: "nonexistent phrase", replacementText: "x" }],
    AUTHOR
  );
  assert.equal(applied, 0);
  assert.equal(skipped.length, 1);
});

test("empty replacement is a pure suggested deletion", () => {
  const state = stateFrom(SAMPLE);
  const { tr } = buildAiSuggestionsTransaction(state, [{ findText: "quick brown ", replacementText: "" }], AUTHOR);
  const next = state.apply(tr!);
  const ranges = collectSuggestionRanges(next.doc);
  assert.equal(ranges.filter((r) => r.kind === "delete").length, 1);
  assert.equal(ranges.filter((r) => r.kind === "insert").length, 0);
});
