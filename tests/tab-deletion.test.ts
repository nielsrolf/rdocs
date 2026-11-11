import assert from "node:assert/strict";
import { test } from "node:test";

import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";

import { tabMarkerTitle } from "../agent-core/anchor-text";
import { validateSuggestions } from "../agent-core/ai-edit-submission";
import { buildTabDeletionSuggestionTransaction } from "../components/document-workspace/ai-suggestions";
import {
  acceptSuggestion,
  createSuggestionPlugin,
  rejectSuggestion
} from "../components/document-workspace/suggestions";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import { buildEditSteps } from "../lib/mcp/apply-edit";
import { computeCommittedContent, listDocumentTabTitles } from "../lib/suggestion-content";
import { deleteTabById } from "../lib/tab-ranges";

// Deleting a tab used to delete only its tabBreak node, so the tab's content
// silently joined the PREVIOUS tab (2026-11-11 report) — from the outline's
// delete button and from MCP's documented "replace the marker with nothing".
// Native agent runs could not delete a tab at all (tab lines were forbidden in
// suggestion findText), so agents renamed tabs to "DELETE ME" instead.

const schema = createDocumentEditorSchema();
const RECORD = { suggestionId: "sg-tab", authorId: "ai-run:r1", authorLabel: "Claude", createdAt: "t" };

const p = (text?: string) => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" });
const tab = (tabId: string, title: string) => ({ type: "tabBreak", attrs: { tabId, title } });
const code = (text: string) => ({ type: "codeBlock", content: [{ type: "text", text }] });
const doc = (...content: object[]) => ({ type: "doc", content });

function shape(node: PMNode): string {
  if (node.isText) return JSON.stringify(node.text);
  if (node.type.name === "tabBreak") return `tab(${JSON.stringify(node.attrs.title)})`;
  const children: string[] = [];
  node.forEach((child) => children.push(shape(child)));
  return `${node.type.name}(${children.join(",")})`;
}

const THREE_TABS = doc(
  tab("a", "Alpha"),
  p("alpha text"),
  tab("b", "Beta"),
  p("beta one"),
  p(),
  { type: "horizontalRule" },
  code("beta code"),
  p("beta two"),
  tab("c", "Gamma"),
  p("gamma text")
);

function nodeOf(json: object) {
  return schema.nodeFromJSON(json);
}

// ------------------------------------------------------------------ UI delete

test("deleting a tab removes its content too, not just the break", () => {
  const tr = new Transform(nodeOf(THREE_TABS));
  assert.equal(deleteTabById(tr, "b"), true);
  assert.equal(shape(tr.doc), 'doc(tab("Alpha"),paragraph("alpha text"),tab("Gamma"),paragraph("gamma text"))');
});

test("deleting the first and the last tab", () => {
  const first = new Transform(nodeOf(THREE_TABS));
  deleteTabById(first, "a");
  assert.match(shape(first.doc), /^doc\(tab\("Beta"\)/);
  assert.doesNotMatch(shape(first.doc), /alpha/);

  const last = new Transform(nodeOf(THREE_TABS));
  deleteTabById(last, "c");
  assert.match(shape(last.doc), /paragraph\("beta two"\)\)$/);
  assert.doesNotMatch(shape(last.doc), /gamma/);
});

test("deleting the only tab leaves one empty paragraph", () => {
  const tr = new Transform(nodeOf(doc(tab("a", "Alpha"), p("alpha text"))));
  deleteTabById(tr, "a");
  assert.equal(shape(tr.doc), "doc(paragraph())");
});

test("deleting an unknown tab is a no-op", () => {
  const tr = new Transform(nodeOf(THREE_TABS));
  assert.equal(deleteTabById(tr, "nope"), false);
  assert.equal(tr.steps.length, 0);
});

// ------------------------------------------------------------------------ MCP

test("MCP: replacing a <tab title> marker with nothing deletes the whole tab", () => {
  const next = buildEditSteps({ doc: nodeOf(THREE_TABS), mode: "replace", findText: '<tab title="Beta">', nodes: [] }).doc;
  assert.equal(shape(next), 'doc(tab("Alpha"),paragraph("alpha text"),tab("Gamma"),paragraph("gamma text"))');
});

// ------------------------------------------------------- native-run suggestions

test("tabMarkerTitle recognises a lone tab marker line only", () => {
  assert.equal(tabMarkerTitle('<tab title="Beta">'), "Beta");
  assert.equal(tabMarkerTitle('  <tab title="R &amp; D">\n</tab>\n'), "R & D");
  assert.equal(tabMarkerTitle('<tab title="Beta">\n\nbeta one'), null);
  assert.equal(tabMarkerTitle("Beta"), null);
});

function suggestedTabDeletion() {
  const state = EditorState.create({ doc: nodeOf(THREE_TABS), plugins: [createSuggestionPlugin()] });
  const tr = buildTabDeletionSuggestionTransaction(state, "Beta", RECORD);
  assert.ok(tr, "tab deletion suggestion built");
  return { original: state, suggested: state.apply(tr!) };
}

test("a suggested tab deletion is reversible and does not change the committed view", () => {
  const { original, suggested } = suggestedTabDeletion();
  assert.equal(
    JSON.stringify(computeCommittedContent(suggested.doc.toJSON())),
    JSON.stringify(computeCommittedContent(original.doc.toJSON()))
  );
  const rejected = suggested.apply(rejectSuggestion(suggested, RECORD.suggestionId)!);
  assert.equal(shape(rejected.doc), shape(original.doc));
});

test("accepting a suggested tab deletion removes the whole tab, matching the accept-all view", () => {
  const { suggested } = suggestedTabDeletion();
  const accepted = suggested.apply(acceptSuggestion(suggested, RECORD.suggestionId)!);
  const expected = 'doc(tab("Alpha"),paragraph("alpha text"),tab("Gamma"),paragraph("gamma text"))';
  assert.equal(shape(accepted.doc), expected);
  assert.equal(shape(nodeOf(computeCommittedContent(suggested.doc.toJSON(), { reject: false }) as object)), expected);
});

test("a tab deletion suggestion needs a unique title", () => {
  const state = EditorState.create({
    doc: nodeOf(doc(tab("a", "Same"), p("x"), tab("b", "Same"), p("y"))),
    plugins: [createSuggestionPlugin()]
  });
  assert.equal(buildTabDeletionSuggestionTransaction(state, "Same", RECORD), null);
  assert.equal(buildTabDeletionSuggestionTransaction(state, "Missing", RECORD), null);
});

test("validator: a <tab title> findText with empty replacement is a tab deletion", () => {
  const titles = listDocumentTabTitles(THREE_TABS);
  assert.deepEqual(titles, ["Alpha", "Beta", "Gamma"]);
  const documentText = "alpha text\nbeta one\nbeta code\nbeta two\ngamma text";
  assert.equal(validateSuggestions([{ findText: '<tab title="Beta">', replacementText: "" }], documentText, titles), null);
  assert.match(
    validateSuggestions([{ findText: '<tab title="Delta">', replacementText: "" }], documentText, titles) ?? "",
    /no tab titled "Delta"/
  );
  assert.match(
    validateSuggestions([{ findText: '<tab title="Beta">', replacementText: "Other" }], documentText, titles) ?? "",
    /empty replacementText/
  );
});
