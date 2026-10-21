import assert from "node:assert/strict";
import { test } from "node:test";

import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";

import {
  buildRichTrackedReplacementTransaction,
  resolveSuggestionRange
} from "../components/document-workspace/ai-suggestions";
import {
  acceptAllSuggestions,
  acceptSuggestion,
  createSuggestionPlugin,
  rejectAllSuggestions,
  rejectSuggestion
} from "../components/document-workspace/suggestions";
import { getDocumentAiBlocks, getDocumentMarkdown } from "../lib/content";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import { buildEditSteps } from "../lib/mcp/apply-edit";
import { markdownToDocNodes } from "../lib/mcp/markdown-doc";
import { replaceRangeWithBlocks } from "../lib/structured-replace";
import { computeCommittedContent } from "../lib/suggestion-content";

// Agents editing a document used to leave it subtly broken (2026-10-21 report):
//  - accepting an agent suggestion on a bullet left "bullet, blank line, text"
//    (the block replacement was spliced INTO the item's paragraph, splitting it,
//    and accept/reject only removed text, leaving the empty halves behind —
//    ~20 list items in production docs had that shape);
//  - selection edits did the same through insertContentAt;
//  - agents could not create tabs (<tab title> came back as literal text), could
//    not see tab headings at all in native runs, and `- [ ] x` task lists came
//    back as literal "[ ] x" bullets.

const schema = createDocumentEditorSchema();
const RECORD = { suggestionId: "sg-1", authorId: "ai-run:r1", authorLabel: "Claude", createdAt: "t" };

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const li = (text: string, ...children: object[]) => ({ type: "listItem", content: [p(text), ...children] });
const ul = (...items: object[]) => ({ type: "bulletList", content: items });
const doc = (...content: object[]) => ({ type: "doc", content });

function fragmentOf(markdown: string): Fragment {
  const nodes = markdownToDocNodes({ markdown, documentId: "doc-1", widgetRows: [] });
  return Fragment.fromArray(nodes.map((node) => schema.nodeFromJSON(node)));
}

// Compact structural rendering: paragraph("x"), listItem(...), empty paragraph().
function shape(node: PMNode): string {
  if (node.isText) return JSON.stringify(node.text);
  if (node.type.name === "tabBreak") return `tab(${JSON.stringify(node.attrs.title)})`;
  const children: string[] = [];
  let text = "";
  node.forEach((child) => {
    if (child.isText) text += child.text;
    else {
      if (text) children.push(JSON.stringify(text));
      text = "";
      children.push(shape(child));
    }
  });
  if (text) children.push(JSON.stringify(text));
  return `${node.type.name}(${children.join(",")})`;
}

function emptyParagraphsInListItems(node: PMNode): number {
  let count = 0;
  node.descendants((child, _pos, parent) => {
    if (parent && (parent.type.name === "listItem" || parent.type.name === "taskItem") && child.isTextblock && child.content.size === 0) {
      count += 1;
    }
  });
  return count;
}

function stateOf(json: object) {
  return EditorState.create({ doc: schema.nodeFromJSON(json), plugins: [createSuggestionPlugin()] });
}

function rangeOf(state: EditorState, text: string) {
  let found = null as { from: number; to: number } | null;
  state.doc.descendants((node, pos) => {
    if (found || !node.isText || !node.text) return;
    const index = node.text.indexOf(text);
    if (index !== -1) found = { from: pos + index, to: pos + index + text.length };
  });
  assert.ok(found, `"${text}" in doc`);
  return found!;
}

function suggest(json: object, findText: string, markdown: string) {
  const state = stateOf(json);
  // The same resolver the browser uses for agent findText anchors.
  const range = resolveSuggestionRange(state.doc, findText);
  assert.ok(range, `"${findText}" resolves`);
  const tr = buildRichTrackedReplacementTransaction(state, range!, fragmentOf(markdown), RECORD);
  assert.ok(tr, "suggestion applied");
  return state.apply(tr!);
}

// ---------------------------------------------------------------- suggestions

test("suggestion on a whole bullet: accept leaves no empty paragraph inside the item", () => {
  const base = doc(ul(li("alpha"), li("beta"), li("gamma")));
  const suggested = suggest(base, "beta", "**Beta:** rewritten");
  const accepted = suggested.apply(acceptSuggestion(suggested, RECORD.suggestionId)!);
  assert.equal(
    shape(accepted.doc),
    'doc(bulletList(listItem(paragraph("alpha")),listItem(paragraph("Beta: rewritten")),listItem(paragraph("gamma"))))'
  );
  const rejected = suggested.apply(rejectSuggestion(suggested, RECORD.suggestionId)!);
  assert.equal(shape(rejected.doc), shape(stateOf(base).doc));
});

test("suggestion with several paragraphs on a bullet: no blank line before or after the text", () => {
  const base = doc(ul(li("alpha"), li("beta"), li("gamma")));
  const suggested = suggest(base, "beta", "beta two\n\nmore detail");
  const accepted = suggested.apply(acceptSuggestion(suggested, RECORD.suggestionId)!);
  assert.equal(emptyParagraphsInListItems(accepted.doc), 0, shape(accepted.doc));
  assert.match(shape(accepted.doc), /listItem\(paragraph\("beta two"\),paragraph\("more detail"\)\)/);
  const rejected = suggested.apply(rejectSuggestion(suggested, RECORD.suggestionId)!);
  assert.equal(shape(rejected.doc), shape(stateOf(base).doc));
});

test("suggestion replacing a bullet with a list adds sibling bullets, not a nested/blank one", () => {
  const base = doc(ul(li("alpha"), li("beta"), li("gamma")));
  const suggested = suggest(base, "beta", "- beta one\n- beta two");
  const accepted = suggested.apply(acceptSuggestion(suggested, RECORD.suggestionId)!);
  assert.equal(
    shape(accepted.doc),
    'doc(bulletList(listItem(paragraph("alpha")),listItem(paragraph("beta one")),listItem(paragraph("beta two")),listItem(paragraph("gamma"))))'
  );
  const rejected = suggested.apply(rejectSuggestion(suggested, RECORD.suggestionId)!);
  assert.equal(shape(rejected.doc), shape(stateOf(base).doc));
});

test("suggestion replacing a paragraph with a heading + paragraph leaves no empty husk", () => {
  const base = doc(p("Intro."), p("Old section text."), p("Outro."));
  const suggested = suggest(base, "Old section text.", "## New section\n\nBody text.");
  const accepted = suggested.apply(acceptSuggestion(suggested, RECORD.suggestionId)!);
  assert.equal(
    shape(accepted.doc),
    'doc(paragraph("Intro."),heading("New section"),paragraph("Body text."),paragraph("Outro."))'
  );
  const rejected = suggested.apply(rejectSuggestion(suggested, RECORD.suggestionId)!);
  assert.equal(shape(rejected.doc), shape(stateOf(base).doc));
});

test("mid-sentence multi-paragraph suggestion merges with the surrounding text", () => {
  const base = doc(p("Start middle end."));
  const suggested = suggest(base, "middle", "first\n\nsecond");
  const accepted = suggested.apply(acceptSuggestion(suggested, RECORD.suggestionId)!);
  assert.equal(shape(accepted.doc), 'doc(paragraph("Start first"),paragraph("second end."))');
  const rejected = suggested.apply(rejectSuggestion(suggested, RECORD.suggestionId)!);
  assert.equal(shape(rejected.doc), shape(stateOf(base).doc));
});

test("accept-all / reject-all agree with the server's committed views (collab guard parity)", () => {
  const cases: Array<[object, string, string]> = [
    [doc(ul(li("alpha"), li("beta"), li("gamma"))), "beta", "beta two\n\nmore detail"],
    [doc(ul(li("alpha"), li("beta"), li("gamma"))), "beta", "- beta one\n- beta two"],
    [doc(p("Intro."), p("Old section text."), p("Outro.")), "Old section text.", "## New section\n\nBody text."],
    [doc(p("Start middle end.")), "middle", "first\n\nsecond"],
    [doc(p("One."), p("Two.")), "Two.", 'Two.\n\n<tab title="Appendix">\n\nAppendix body.']
  ];
  for (const [base, findText, markdown] of cases) {
    const suggested = suggest(base, findText, markdown);
    const json = suggested.doc.toJSON();
    const accepted = suggested.apply(acceptAllSuggestions(suggested)!);
    const rejected = suggested.apply(rejectAllSuggestions(suggested)!);
    assert.equal(
      shape(schema.nodeFromJSON(computeCommittedContent(json, { reject: false }))),
      shape(accepted.doc),
      `accept parity for ${markdown}`
    );
    assert.equal(
      shape(schema.nodeFromJSON(computeCommittedContent(json))),
      shape(rejected.doc),
      `reject parity for ${markdown}`
    );
    // A comment-access user may add this suggestion: the committed view is unchanged.
    assert.equal(
      JSON.stringify(computeCommittedContent(json)),
      JSON.stringify(computeCommittedContent(stateOf(base).doc.toJSON())),
      `committed view unchanged by suggesting ${markdown}`
    );
  }
});

// ----------------------------------------------------- direct replacements

test("selection-edit replacement of a bullet's text does not split the item", () => {
  const state = stateOf(doc(ul(li("alpha"), li("beta"), li("gamma"))));
  const tr = state.tr;
  replaceRangeWithBlocks(tr, rangeOf(state, "beta").from, rangeOf(state, "beta").to, fragmentOf("**Beta** improved"));
  assert.equal(
    shape(tr.doc),
    'doc(bulletList(listItem(paragraph("alpha")),listItem(paragraph("Beta improved")),listItem(paragraph("gamma"))))'
  );
});

test("replacing a bullet's text with a heading + text does not leave a blank first line", () => {
  const state = stateOf(doc(ul(li("alpha"), li("beta"), li("gamma"))));
  const editDoc = buildEditSteps({ doc: state.doc, mode: "replace", findText: "beta", nodes: markdownToDocNodes({ markdown: "beta\n\nnew detail", documentId: "d", widgetRows: [] }) }).doc;
  assert.equal(emptyParagraphsInListItems(editDoc), 0, shape(editDoc));
});

// --------------------------------------------------------- markdown writes

test("task-list markdown becomes a real task list", () => {
  const fragment = fragmentOf("- [ ] todo\n- [x] done");
  const node = fragment.child(0);
  assert.equal(node.type.name, "taskList", shape(node));
  assert.equal(node.child(0).attrs.checked, false);
  assert.equal(node.child(1).attrs.checked, true);
  assert.equal(node.child(1).textContent, "done");
});

test("<tab title> markers in agent markdown create tab breaks with ids", () => {
  const fragment = fragmentOf('Intro text.\n\n<tab title="Results &amp; notes">\n\n## Findings\n\n- one\n\n</tab>');
  const shapes: string[] = [];
  fragment.forEach((node) => shapes.push(shape(node)));
  assert.deepEqual(shapes, ['paragraph("Intro text.")', 'tab("Results & notes")', 'heading("Findings")', 'bulletList(listItem(paragraph("one")))']);
  const tab = fragment.child(1);
  assert.ok(typeof tab.attrs.tabId === "string" && tab.attrs.tabId.length > 0, "a fresh tab id");
});

test("a document with tabs survives read_document → replace_all round-trip", () => {
  const original = doc(
    { type: "tabBreak", attrs: { tabId: "t1", title: "Overview" } },
    p("First tab."),
    { type: "tabBreak", attrs: { tabId: "t2", title: "Details" } },
    ul(li("point"))
  );
  const markdown = getDocumentMarkdown(original, { pastedImagePlaceholders: true });
  const nodes = markdownToDocNodes({ markdown, documentId: "d", widgetRows: [] });
  const rebuilt = buildEditSteps({ doc: schema.nodeFromJSON(original), mode: "replace_all", nodes }).doc;
  assert.equal(
    shape(rebuilt),
    'doc(tab("Overview"),paragraph("First tab."),tab("Details"),bulletList(listItem(paragraph("point"))))'
  );
});

test("MCP: a tab can be renamed by replacing its <tab title> marker (id kept)", () => {
  const original = schema.nodeFromJSON(
    doc({ type: "tabBreak", attrs: { tabId: "t1", title: "Overview" } }, p("Body."))
  );
  const nodes = markdownToDocNodes({ markdown: '<tab title="Summary">', documentId: "d", widgetRows: [] });
  const next = buildEditSteps({ doc: original, mode: "replace", findText: '<tab title="Overview">', nodes }).doc;
  assert.equal(next.child(0).type.name, "tabBreak");
  assert.equal(next.child(0).attrs.title, "Summary");
  assert.equal(next.child(0).attrs.tabId, "t1");
  assert.equal(shape(next), 'doc(tab("Summary"),paragraph("Body."))');
});

test("MCP: a new tab inserted from inside a list lands at the top level", () => {
  const original = schema.nodeFromJSON(doc(ul(li("alpha"), li("beta")), p("After.")));
  const nodes = markdownToDocNodes({ markdown: 'beta\n\n<tab title="New">\n\nNew tab body.', documentId: "d", widgetRows: [] });
  const next = buildEditSteps({ doc: original, mode: "replace", findText: "beta", nodes }).doc;
  next.descendants((node, _pos, parent) => {
    if (node.type.name === "tabBreak") assert.equal(parent?.type.name, "doc", shape(next));
  });
  assert.match(shape(next), /tab\("New"\)/);
});

// ---------------------------------------------------------- native read view

test("native runs see bullets, headings and tab titles in the document context", () => {
  const blocks = getDocumentAiBlocks(
    doc(
      { type: "tabBreak", attrs: { tabId: "t1", title: "Plan" } },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Goals" }] },
      ul(li("ship it", ul(li("nested")))),
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p("done thing")] }] },
      { type: "tabBreak", attrs: { tabId: "t2", title: "Notes" } },
      p("Some notes.")
    )
  );
  const text = blocks.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
  assert.match(text, /<tab title="Plan">/);
  assert.match(text, /<tab title="Notes">/);
  assert.match(text, /^## Goals$/m);
  assert.match(text, /^- ship it$/m);
  assert.match(text, /^ {2}- nested$/m);
  assert.match(text, /^- \[x\] done thing$/m);
});

test("findText copied from the markdown view (checkbox, nested bullet, tab line) still anchors", async () => {
  const { validateSuggestions } = await import("../lib/ai-edit-submission");
  const { flattenDocumentAnchorText } = await import("../lib/suggestion-content");
  const content = doc(
    { type: "tabBreak", attrs: { tabId: "t1", title: "Plan" } },
    ul(li("ship it", ul(li("deeply", ul(li("nested item")))))),
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p("done thing")] }] },
    { type: "tabBreak", attrs: { tabId: "t2", title: "Notes" } },
    p("Some notes.")
  );
  const anchorText = flattenDocumentAnchorText(content);
  const state = stateOf(content);
  for (const findText of ["- [x] done thing", "    - nested item", '<tab title="Notes">\n\nSome notes.']) {
    assert.equal(validateSuggestions([{ findText, replacementText: "changed" }], anchorText), null, findText);
    assert.ok(resolveSuggestionRange(state.doc, findText), `client resolves ${JSON.stringify(findText)}`);
  }
});

function mcpReplace(json: object, findText: string, markdown: string) {
  const nodes = markdownToDocNodes({ markdown, documentId: "d", widgetRows: [] });
  return buildEditSteps({ doc: schema.nodeFromJSON(json), mode: "replace", findText, nodes }).doc;
}

function acceptedSuggestion(json: object, findText: string, markdown: string) {
  const suggested = suggest(json, findText, markdown);
  const rejected = suggested.apply(rejectSuggestion(suggested, RECORD.suggestionId)!);
  assert.equal(shape(rejected.doc), shape(stateOf(json).doc), `reject restores the original for ${markdown}`);
  return suggested.apply(acceptSuggestion(suggested, RECORD.suggestionId)!).doc;
}

test("a heading replacing a bullet's text becomes the bullet's line (a bullet cannot start with a heading)", () => {
  const base = doc(ul(li("alpha"), li("beta"), li("gamma")));
  const expected = 'doc(bulletList(listItem(paragraph("alpha")),listItem(paragraph("Heading"),paragraph("text")),listItem(paragraph("gamma"))))';
  assert.equal(shape(mcpReplace(base, "beta", "### Heading\n\ntext")), expected);
  assert.equal(shape(acceptedSuggestion(base, "beta", "### Heading\n\ntext")), expected);
});

test("rewriting a whole bullet list as a task list replaces the list", () => {
  const base = doc(p("Before."), ul(li("alpha"), li("beta")), p("After."));
  const expected = 'doc(paragraph("Before."),taskList(taskItem(paragraph("alpha")),taskItem(paragraph("beta"))),paragraph("After."))';
  assert.equal(shape(mcpReplace(base, "alpha\nbeta", "- [ ] alpha\n- [ ] beta")), expected);
  assert.equal(shape(acceptedSuggestion(base, "alpha\nbeta", "- [ ] alpha\n- [ ] beta")), expected);
});

test("splitting a bullet that has sub-items keeps the sub-items (never deletes them)", () => {
  const base = doc(ul(li("alpha"), li("beta", ul(li("child"))), li("gamma")));
  const expected =
    'doc(bulletList(listItem(paragraph("alpha")),listItem(paragraph("b1"),bulletList(listItem(paragraph("child")))),listItem(paragraph("b2")),listItem(paragraph("gamma"))))';
  assert.equal(shape(mcpReplace(base, "beta", "- b1\n- b2")), expected);
  assert.equal(shape(acceptedSuggestion(base, "beta", "- b1\n- b2")), expected);
});
