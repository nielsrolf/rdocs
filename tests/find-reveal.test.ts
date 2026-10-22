import assert from "node:assert/strict";
import test from "node:test";

import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import { findMatches, pickMatchIndex } from "../components/document-workspace/search";
import { listTabs, tabContainingPos } from "../components/document-workspace/tabs";

const schema = createDocumentEditorSchema();
const doc = schema.nodeFromJSON({
  type: "doc",
  content: [
    { type: "tabBreak", attrs: { tabId: "t1", title: "One" } },
    { type: "paragraph", content: [{ type: "text", text: "alpha beta" }] },
    { type: "tabBreak", attrs: { tabId: "t2", title: "Two" } },
    { type: "paragraph", content: [{ type: "text", text: "beta gamma beta" }] }
  ]
});

test("find: each match maps to the tab that contains it, so stepping can switch tabs", () => {
  const tabs = listTabs(doc);
  const matches = findMatches(doc, "beta", false);
  assert.equal(matches.length, 3);
  assert.deepEqual(
    matches.map((match) => tabContainingPos(tabs, match.from)?.id),
    ["t1", "t2", "t2"]
  );
  assert.equal(tabContainingPos([], 5), null);
});

test("find: a new query starts at the first match inside the visible tab", () => {
  const tabs = listTabs(doc);
  const matches = findMatches(doc, "beta", false);
  const t2 = tabs.find((tab) => tab.id === "t2")!;
  assert.equal(pickMatchIndex(matches, { from: t2.contentFrom, to: t2.contentTo }), 1);
  // Nothing in the visible tab → fall back to the first match in the document.
  const gamma = findMatches(doc, "alpha", false);
  assert.equal(pickMatchIndex(gamma, { from: t2.contentFrom, to: t2.contentTo }), 0);
  assert.equal(pickMatchIndex(matches, null), 0);
});
