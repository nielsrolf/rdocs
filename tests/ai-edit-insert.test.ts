import assert from "node:assert/strict";
import test from "node:test";

import { buildAiEditInsertContent, normalizeWidgetsOutsideTables } from "../components/document-workspace/ai-edit-insert";
import type { AiEditImage, AiEditWidget } from "../components/document-workspace/types";

// Regression coverage for: "AI edits sometimes failed to update the content" and
// "widgets would not appear in the document because of false paths of saved
// assets". buildAiEditInsertContent turns the agent's markdown + images +
// widgets into the markup the editor inserts; if it drops content or mangles the
// asset src/embedSource, the figure/widget renders blank or missing.

function widget(overrides: Partial<AiEditWidget> = {}): AiEditWidget {
  return {
    id: "w1",
    label: "FFT Explorer",
    buildCmd: "python widgets/build.py",
    embedSource: "assets/fft.html",
    src: "/api/documents/doc1/widgets/w1/source",
    ...overrides
  };
}

function image(overrides: Partial<AiEditImage> = {}): AiEditImage {
  return {
    path: "assets/plot.png",
    src: "/api/documents/doc1/repo-files?path=assets%2Fplot.png",
    alt: "A plot",
    caption: null,
    ...overrides
  };
}

test("plain markdown becomes rendered HTML (content is not dropped)", () => {
  const html = buildAiEditInsertContent({
    replacementText: "## Heading\n\nA paragraph of text.",
    sourceLinks: [],
    images: [],
    widgets: [],
    documentId: "doc1",
    shareToken: null
  });
  assert.match(html, /<h2[^>]*>Heading<\/h2>/);
  assert.match(html, /A paragraph of text\./);
});

test("an inline markdown image resolves to a repo-image figure with the asset src preserved", () => {
  const html = buildAiEditInsertContent({
    replacementText: "Before figure.\n\n![A plot](assets/plot.png)\n\nAfter figure.",
    sourceLinks: [],
    images: [image()],
    widgets: [],
    documentId: "doc1",
    shareToken: null
  });
  assert.match(html, /data-repo-image/);
  // The exact asset src must survive — a mangled path is the "widget/image won't
  // appear" bug.
  assert.match(html, /src="\/api\/documents\/doc1\/repo-files\?path=assets%2Fplot\.png"/);
  assert.match(html, /Before figure\./);
  assert.match(html, /After figure\./);
});

test("an unused images-array entry is still appended as a figure", () => {
  const html = buildAiEditInsertContent({
    replacementText: "Just some prose with no inline image.",
    sourceLinks: [],
    images: [image({ path: "assets/standalone.png", src: "/api/documents/doc1/repo-files?path=assets%2Fstandalone.png" })],
    widgets: [],
    documentId: "doc1",
    shareToken: null
  });
  assert.match(html, /data-repo-image/);
  assert.match(html, /standalone\.png/);
});

test("a widget becomes an embedded-widget node with embedSource and src preserved", () => {
  const html = buildAiEditInsertContent({
    replacementText: "Here is an explorer:",
    sourceLinks: [],
    images: [],
    widgets: [widget()],
    documentId: "doc1",
    shareToken: "tok"
  });
  assert.match(html, /data-embedded-widget/);
  assert.match(html, /embedSource="assets\/fft\.html"/);
  assert.match(html, /src="\/api\/documents\/doc1\/widgets\/w1\/source"/);
  assert.match(html, /buildCmd="python widgets\/build\.py"/);
});

test("source links are appended", () => {
  const html = buildAiEditInsertContent({
    replacementText: "A finding.",
    sourceLinks: ["https://example.com/paper"],
    images: [],
    widgets: [],
    documentId: "doc1",
    shareToken: null
  });
  assert.match(html, /Sources:/);
  assert.match(html, /href="https:\/\/example\.com\/paper"/);
});

test("an empty submission still yields insertable content (never empty string)", () => {
  const html = buildAiEditInsertContent({
    replacementText: "",
    sourceLinks: [],
    images: [],
    widgets: [],
    documentId: "doc1",
    shareToken: null
  });
  assert.equal(html, "<p></p>");
});

test("normalizeWidgetsOutsideTables hoists a widget out of a table cell", () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [{ type: "embeddedWidget", attrs: { label: "W" } }]
              }
            ]
          }
        ]
      }
    ]
  };
  const { content, changed } = normalizeWidgetsOutsideTables(doc);
  assert.equal(changed, true);
  // The widget must now be a top-level sibling of the table, not inside it.
  const types = (content.content ?? []).map((n) => n.type);
  assert.ok(types.includes("embeddedWidget"), "widget hoisted to top level");
  assert.ok(types.includes("table"), "table retained");
});

test("normalizeWidgetsOutsideTables leaves a widget already outside a table untouched", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "x" }] },
      { type: "embeddedWidget", attrs: { label: "W" } }
    ]
  };
  const { changed } = normalizeWidgetsOutsideTables(doc);
  assert.equal(changed, false);
});
