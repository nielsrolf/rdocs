import assert from "node:assert/strict";
import { test } from "node:test";

import { Fragment } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";

import {
  buildTableRowSuggestionTransaction,
  resolveSuggestionRange
} from "../components/document-workspace/ai-suggestions";
import {
  acceptSuggestion,
  collectSuggestionRanges,
  createSuggestionPlugin,
  rejectSuggestion
} from "../components/document-workspace/suggestions";
import { validateSuggestions } from "../lib/ai-edit-submission";
import { getDocumentMarkdown } from "../lib/content";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import { markdownToDocNodes } from "../lib/mcp/markdown-doc";
import { computeCommittedContent, flattenDocumentAnchorText } from "../lib/suggestion-content";

// Native (tracked-change) suggestions on table rows. Before this, a row anchor
// (`| a | b |`) never validated, and an anchor spanning cells was spliced as
// prose: the replacement landed in the first cell (2026-11-12).

const schema = createDocumentEditorSchema();
const RECORD = { suggestionId: "sg-table", authorId: "ai-run:r1", authorLabel: "Claude", createdAt: "2026-11-16T00:00:00.000Z" };

function paragraph(text: string) {
  return text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };
}

function row(type: "tableHeader" | "tableCell", ...cells: string[]) {
  return { type: "tableRow", content: cells.map((text) => ({ type, content: [paragraph(text)] })) };
}

const DOC = {
  type: "doc",
  content: [
    paragraph("Intro."),
    {
      type: "table",
      content: [
        row("tableHeader", "Eval", "Status"),
        row("tableCell", "toxicity", "Done"),
        row("tableCell", "hate speech", "In progress"),
        row("tableCell", "hallucinations", "In progress")
      ]
    },
    paragraph("Outro.")
  ]
};

function stateFrom(json: unknown) {
  return EditorState.create({ doc: schema.nodeFromJSON(json), plugins: [createSuggestionPlugin()] });
}

function parse(markdown: string) {
  const nodes = markdownToDocNodes({ markdown, documentId: "d", widgetRows: [] });
  return Fragment.fromArray(nodes.map((node) => schema.nodeFromJSON(node)));
}

function tableLines(json: unknown) {
  return getDocumentMarkdown(json as never)
    .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1")
    .split("\n")
    .filter((line) => line.startsWith("|"));
}

function suggest(state: EditorState, findText: string, replacementText: string) {
  const range = resolveSuggestionRange(state.doc, findText);
  assert.ok(range, "the row anchor resolves");
  return buildTableRowSuggestionTransaction(state, range!, findText, replacementText, RECORD, parse);
}

// Applies the suggestion and checks both resolutions against the committed views.
function resolveBoth(findText: string, replacementText: string) {
  const state = stateFrom(DOC);
  const tr = suggest(state, findText, replacementText);
  assert.ok(tr, "the suggestion is placed as a table-row change");
  const suggested = state.apply(tr!);

  // A comment-permission author may only add suggestions: rejecting everything
  // must give back the original document.
  assert.deepEqual(computeCommittedContent(suggested.doc.toJSON()), computeCommittedContent(state.doc.toJSON()));

  const accepted = suggested.apply(acceptSuggestion(suggested, RECORD.suggestionId)!);
  const rejected = suggested.apply(rejectSuggestion(suggested, RECORD.suggestionId)!);
  assert.deepEqual(rejected.doc.toJSON(), state.doc.toJSON(), "reject restores the document");
  assert.deepEqual(
    computeCommittedContent(suggested.doc.toJSON(), { reject: false }),
    computeCommittedContent(accepted.doc.toJSON()),
    "the accept-all view equals the accepted document"
  );
  assert.equal(collectSuggestionRanges(accepted.doc).length, 0);
  return { suggested, accepted };
}

test("row anchors copied from the markdown table validate and resolve", () => {
  const anchorText = flattenDocumentAnchorText(DOC);
  const suggestion = { findText: "| hate speech | In progress |", replacementText: "| hate speech | Evaluated |" };
  assert.equal(validateSuggestions([suggestion], anchorText), null);
  const multi = {
    findText: "| Eval | Status |\n| --- | --- |\n| toxicity | Done |",
    replacementText: "| Eval | Result |\n| --- | --- |\n| toxicity | Passed |"
  };
  assert.equal(validateSuggestions([multi], anchorText), null);

  const state = stateFrom(DOC);
  const range = resolveSuggestionRange(state.doc, suggestion.findText);
  assert.ok(range);
  assert.equal(state.doc.textBetween(range!.from, range!.to, "|"), "hate speech|In progress");
});

test("a row suggestion changes only the cells that differ", () => {
  const { suggested, accepted } = resolveBoth(
    "| hate speech | In progress |",
    "| hate speech | Evaluated on **3** models |"
  );
  const ranges = collectSuggestionRanges(suggested.doc);
  assert.deepEqual(
    ranges.filter((range) => range.kind === "delete").map((range) => suggested.doc.textBetween(range.from, range.to)),
    ["In progress"]
  );
  assert.deepEqual(tableLines(accepted.doc.toJSON()), [
    "| Eval | Status |",
    "| --- | --- |",
    "| toxicity | Done |",
    "| hate speech | Evaluated on **3** models |",
    "| hallucinations | In progress |"
  ]);
});

test("a row suggestion can add rows; rejecting leaves no empty row", () => {
  const { accepted } = resolveBoth(
    "| hallucinations | In progress |",
    "| hallucinations | Done |\n| bias | Planned |"
  );
  assert.deepEqual(tableLines(accepted.doc.toJSON()).slice(4), ["| hallucinations | Done |", "| bias | Planned |"]);
});

test("an empty replacement suggests deleting the rows; accepting removes them", () => {
  const { accepted } = resolveBoth("| hate speech | In progress |\n| hallucinations | In progress |", "");
  assert.deepEqual(tableLines(accepted.doc.toJSON()), ["| Eval | Status |", "| --- | --- |", "| toxicity | Done |"]);
});

test("fewer replacement rows than matched strikes the surplus rows", () => {
  const { accepted } = resolveBoth(
    "| hate speech | In progress |\n| hallucinations | In progress |",
    "| safety (merged) | Done |"
  );
  assert.deepEqual(tableLines(accepted.doc.toJSON()).slice(3), ["| safety (merged) | Done |"]);
});

test("the whole table can be suggested with different columns", () => {
  const all = tableLines(DOC).join("\n");
  const { accepted } = resolveBoth(all, "| Eval | Status | Owner |\n| --- | --- | --- |\n| toxicity | Done | A |");
  assert.deepEqual(tableLines(accepted.doc.toJSON()), [
    "| Eval | Status | Owner |",
    "| --- | --- | --- |",
    "| toxicity | Done | A |"
  ]);
  assert.deepEqual(
    (accepted.doc.toJSON().content as Array<{ type: string }>).map((node) => node.type),
    ["paragraph", "table", "paragraph"]
  );
});

test("an anchor spanning cells with a non-row replacement is not placed", () => {
  const state = stateFrom(DOC);
  assert.equal(suggest(state, "hate speech\nIn progress", "hate speech: evaluated"), null);
});

test("an anchor inside one cell is left to the ordinary path", () => {
  const state = stateFrom(DOC);
  assert.equal(suggest(state, "hallucinations", "hallucinations (v2)"), undefined);
});
