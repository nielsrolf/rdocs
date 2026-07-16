import assert from "node:assert/strict";
import test from "node:test";

import { findLatexMatchesInDoc } from "../components/document-workspace/latex";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import { renderCommentHtml } from "../lib/mention-markdown";

const schema = createDocumentEditorSchema();

function docFromJson(json: unknown) {
  return schema.nodeFromJSON(json);
}

test("findLatexMatchesInDoc finds an equation in a single text node", () => {
  const doc = docFromJson({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Energy: $E=mc^2$ done" }] }]
  });

  const matches = findLatexMatchesInDoc(doc);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].latex, "E=mc^2");
  assert.equal(matches[0].displayMode, false);
});

test("findLatexMatchesInDoc still finds the equation when a commentAnchor mark splits its text node", () => {
  // Commenting on (part of) an equation applies the commentAnchor mark, which
  // splits the underlying text node — the $ delimiters end up in different
  // text nodes. Rendering must survive that.
  const doc = docFromJson({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Energy: $E=" },
          {
            type: "text",
            text: "mc^2",
            marks: [{ type: "commentAnchor", attrs: { threadId: "thread-1" } }]
          },
          { type: "text", text: "$ done" }
        ]
      }
    ]
  });

  const matches = findLatexMatchesInDoc(doc);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].latex, "E=mc^2");
  // Positions: paragraph content starts at 1, "$" is at offset 8 → pos 9.
  assert.equal(matches[0].from, 9);
  assert.equal(matches[0].to, 9 + "$E=mc^2$".length);
});

test("findLatexMatchesInDoc does not match across separate paragraphs or inline atoms", () => {
  const doc = docFromJson({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "price is $5" }] },
      { type: "paragraph", content: [{ type: "text", text: "and $10 here" }] }
    ]
  });

  assert.equal(findLatexMatchesInDoc(doc).length, 0);
});

test("comment markdown renders inline and display latex via katex", () => {
  const viewer = { members: [], currentUserId: null };

  const inline = renderCommentHtml("The bound $x \\le 2$ holds.", viewer);
  assert.match(inline, /class="katex/);
  assert.doesNotMatch(inline, /\$x \\le 2\$/);

  const display = renderCommentHtml("$$\\sum_i x_i$$", viewer);
  assert.match(display, /katex-display/);
});

test("comment markdown leaves escaped dollars and plain text alone", () => {
  const viewer = { members: [], currentUserId: null };
  const html = renderCommentHtml("costs \\$5 today", viewer);
  assert.doesNotMatch(html, /class="katex/);
});

test("AI-edit insert pipeline keeps latex as literal $...$ source text (editor renders via decorations)", async () => {
  const { markdownToDocNodes } = await import("../lib/mcp/markdown-doc");

  const markdown = [
    "Every observer measures $c \\approx 3\\times10^8\\ \\text{m/s}$ for light.",
    "",
    "$$c = 299{,}792{,}458\\ \\text{m/s}$$"
  ].join("\n");

  const nodes = markdownToDocNodes({ markdown, documentId: "doc-test", widgetRows: [] });
  const doc = docFromJson({ type: "doc", content: nodes });
  const text = doc.textBetween(0, doc.content.size, "\n");

  // The literal source must survive — no KaTeX HTML flattened into text
  // (which triples the equation: mathml text + tex annotation + html text).
  assert.ok(text.includes("$c \\approx 3\\times10^8\\ \\text{m/s}$"), `inline latex lost: ${text}`);
  assert.ok(text.includes("$$c = 299{,}792{,}458\\ \\text{m/s}$$"), `display latex lost: ${text}`);
  assert.doesNotMatch(text, /≈/);

  // And the editor's decoration renderer must find both equations.
  const matches = findLatexMatchesInDoc(doc);
  assert.equal(matches.length, 2);
});
