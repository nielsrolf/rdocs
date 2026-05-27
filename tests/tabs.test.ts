import assert from "node:assert/strict";
import test from "node:test";

import { getDocumentMarkdown } from "../lib/content";

test("getDocumentMarkdown: no tabBreaks produces plain markdown without <tab> wrapper", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Intro" }] },
      { type: "paragraph", content: [{ type: "text", text: "Body" }] }
    ]
  };

  const markdown = getDocumentMarkdown(doc);
  assert.ok(!markdown.includes("<tab"), `expected no tab wrapper, got:\n${markdown}`);
  assert.ok(markdown.includes("## Intro"));
  assert.ok(markdown.includes("Body"));
});

test("getDocumentMarkdown: tabBreaks split doc into <tab title=...> sections", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "tabBreak", attrs: { tabId: "t1", title: "Intro" } },
      { type: "paragraph", content: [{ type: "text", text: "Welcome" }] },
      { type: "tabBreak", attrs: { tabId: "t2", title: "Results" } },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Score" }] },
      { type: "paragraph", content: [{ type: "text", text: "0.91" }] }
    ]
  };

  const markdown = getDocumentMarkdown(doc);
  assert.match(markdown, /<tab title="Intro">\nWelcome\n<\/tab>/);
  assert.match(markdown, /<tab title="Results">\n## Score\n\n0\\\.91\n<\/tab>/);
  // Tabs appear in order.
  const introIdx = markdown.indexOf("Intro");
  const resultsIdx = markdown.indexOf("Results");
  assert.ok(introIdx >= 0 && resultsIdx > introIdx);
});

test("getDocumentMarkdown: untitled prelude before first tabBreak is preserved", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Preamble" }] },
      { type: "tabBreak", attrs: { tabId: "t1", title: "First tab" } },
      { type: "paragraph", content: [{ type: "text", text: "Inside" }] }
    ]
  };

  const markdown = getDocumentMarkdown(doc);
  assert.ok(markdown.startsWith("Preamble"));
  assert.match(markdown, /<tab title="First tab">\nInside\n<\/tab>/);
});

test("getDocumentMarkdown: tab title escapes HTML-sensitive characters", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "tabBreak", attrs: { tabId: "t1", title: `A & B "two"` } },
      { type: "paragraph", content: [{ type: "text", text: "x" }] }
    ]
  };

  const markdown = getDocumentMarkdown(doc);
  assert.match(markdown, /<tab title="A &amp; B &quot;two&quot;">/);
});

test("getDocumentMarkdown: empty tab still emits wrapper so LLM sees the tab", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "tabBreak", attrs: { tabId: "t1", title: "Empty" } }
    ]
  };

  const markdown = getDocumentMarkdown(doc);
  assert.match(markdown, /<tab title="Empty">\s*<\/tab>/);
});
