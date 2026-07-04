import assert from "node:assert/strict";
import test from "node:test";

import { aiEditMarkdown } from "../components/document-workspace/markdown";
import { getDocumentAiBlocks, getDocumentMarkdown, getDocumentPlainText } from "../lib/content";

const tableDoc = {
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Name" }] }] },
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }] }
          ]
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "a|b" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] }
          ]
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "three" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "four" }] }] }
          ]
        }
      ]
    }
  ]
};

const richDoc = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Intro" }]
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world", marks: [{ type: "bold" }] },
        { type: "text", text: " and " },
        {
          type: "text",
          text: "Anthropic",
          marks: [{ type: "link", attrs: { href: "https://www.anthropic.com" } }]
        }
      ]
    },
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }] }
      ]
    },
    {
      type: "repoImage",
      attrs: {
        src: "/api/documents/doc-1/repo-files?path=assets/accuracy.png",
        path: "assets/accuracy.png",
        alt: "Accuracy plot",
        caption: "Comparison"
      }
    },
    {
      type: "embeddedWidget",
      attrs: {
        widgetId: "widget-1",
        label: "Rollout explorer",
        buildCmd: "python widgets/build_rollout.py",
        embedSource: "assets/rollout.html",
        src: "/api/documents/doc-1/widgets/widget-1/source"
      }
    }
  ]
};

test("getDocumentMarkdown serializes headings, lists, marks, and links", () => {
  const md = getDocumentMarkdown(richDoc);
  assert.match(md, /## Intro/);
  assert.match(md, /Hello \*\*world\*\*/);
  assert.match(md, /\[Anthropic\]\(https:\/\/www\.anthropic\.com\)/);
  assert.match(md, /- first/);
  assert.match(md, /- second/);
});

test("getDocumentMarkdown preserves repo image and widget references", () => {
  const md = getDocumentMarkdown(richDoc);
  assert.match(md, /!\[Accuracy plot\]\(assets\/accuracy\.png "Comparison"\)/);
  assert.match(md, /\[Interactive widget: Rollout explorer\]\(assets\/rollout\.html\)/);
});

test("getDocumentMarkdown handles code blocks without escaping their content", () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "codeBlock",
        attrs: { language: "python" },
        content: [{ type: "text", text: "x = 1 + 2 * 3" }]
      }
    ]
  };
  const md = getDocumentMarkdown(doc);
  assert.match(md, /```python\nx = 1 \+ 2 \* 3\n```/);
});

test("getDocumentAiBlocks splits text, repo images, and widgets into structured blocks", () => {
  const blocks = getDocumentAiBlocks(richDoc);
  const types = blocks.map((block) => block.type);
  assert.ok(types.includes("text"));
  assert.ok(types.includes("repoImage"));
  assert.ok(types.includes("widget"));

  const repoImage = blocks.find((block) => block.type === "repoImage");
  if (repoImage?.type !== "repoImage") {
    assert.fail("expected repoImage block");
  }
  assert.equal(repoImage.path, "assets/accuracy.png");
  assert.equal(repoImage.alt, "Accuracy plot");

  const widget = blocks.find((block) => block.type === "widget");
  if (widget?.type !== "widget") {
    assert.fail("expected widget block");
  }
  assert.equal(widget.widgetId, "widget-1");
  assert.equal(widget.embedSource, "assets/rollout.html");
});

test("getDocumentAiBlocks captures pasted images with src and alt", () => {
  const blocks = getDocumentAiBlocks({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Above" }] },
      { type: "image", attrs: { src: "data:image/png;base64,abc", alt: "Diagram" } },
      { type: "paragraph", content: [{ type: "text", text: "Below" }] }
    ]
  });

  const image = blocks.find((block) => block.type === "image");
  if (image?.type !== "image") {
    assert.fail("expected image block");
  }
  assert.equal(image.src, "data:image/png;base64,abc");
  assert.equal(image.alt, "Diagram");
});

test("getDocumentPlainText skips through repo images and widgets in plain text", () => {
  const text = getDocumentPlainText(richDoc);
  assert.match(text, /Intro/);
  assert.match(text, /Hello world/);
  assert.match(text, /Repository image: Accuracy plot/);
  assert.match(text, /Interactive widget: Rollout explorer/);
});

test("getDocumentMarkdown emits valid GFM for tables with a delimiter row and escaped pipes", () => {
  const md = getDocumentMarkdown(tableDoc);
  const lines = md.split("\n").filter((line) => line.trim().length > 0);

  // Header row, GFM delimiter row, then two body rows.
  assert.equal(lines[0], "| Name | Value |");
  assert.equal(lines[1], "| --- | --- |");
  assert.equal(lines[2], "| a\\|b | two |");
  assert.equal(lines[3], "| three | four |");

  // The pipe inside the cell must be escaped so it does not split the column.
  assert.match(md, /a\\\|b/);
});

test("table markdown round-trips through the AI-edit markdown-it pipeline into a real table", () => {
  // doc -> GFM markdown (server serialization)
  const md = getDocumentMarkdown(tableDoc);
  // GFM -> HTML via the exact markdown-it instance buildAiEditInsertContent uses.
  const html = aiEditMarkdown.render(md);

  // A real HTML table (which TipTap's Table extension parses into a `table` node),
  // NOT a paragraph of literal pipes (the pre-fix failure mode).
  assert.match(html, /<table>/);
  assert.match(html, /<th>Name<\/th>/);
  assert.match(html, /<th>Value<\/th>/);
  // Escaped pipe is unescaped by markdown-it back into a literal `|` inside the cell.
  assert.match(html, /<td>a\|b<\/td>/);
  assert.match(html, /<td>three<\/td>/);
  assert.match(html, /<td>four<\/td>/);
  assert.doesNotMatch(html, /<p>\s*\|/);
});

test("getDocumentAiBlocks preserves table structure as GFM, consistent with getDocumentPlainText", () => {
  const blocks = getDocumentAiBlocks(tableDoc);
  const tableBlock = blocks.find((block) => block.type === "text" && block.text.includes("| Name |"));
  if (!tableBlock || tableBlock.type !== "text") {
    assert.fail("expected a text block containing the serialized table");
  }

  assert.match(tableBlock.text, /\| Name \| Value \|/);
  assert.match(tableBlock.text, /\| --- \| --- \|/);
  assert.match(tableBlock.text, /\| a\\\|b \| two \|/);
  assert.match(tableBlock.text, /\| three \| four \|/);

  // Consistency constraint (Gap C): what the agent SEES (AI blocks) must match the
  // findText / anchor haystack (getDocumentPlainText). Both must carry the same GFM.
  const plain = getDocumentPlainText(tableDoc);
  assert.match(plain, /\| Name \| Value \|/);
  assert.match(plain, /\| --- \| --- \|/);
  assert.match(plain, /\| a\\\|b \| two \|/);
});
