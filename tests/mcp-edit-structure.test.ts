import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { getDocumentMarkdown, parseDocumentContent } from "../lib/content";
import { db } from "../lib/db";
import { applyMarkdownEdit, McpEditError } from "../lib/mcp/apply-edit";

// Structural editing bugs reported against the MCP replace_in_document tool:
// 1. widget placeholders were invisible to find_text (no way to delete/move a widget)
// 2. replacement lists always nested under the matched list item (no way to add a sibling)
// 3. find_text copied from read_document markdown (list markers, headings, escapes,
//    paragraph breaks) never matched the document text

async function makeUser() {
  return db.user.create({
    data: { email: `mcp-edit-${crypto.randomUUID()}@example.com`, name: "mcp-edit", passwordHash: "x" }
  });
}

async function makeDoc(ownerId: string, content: object) {
  return db.document.create({
    data: { title: "MCP structure test", content: JSON.stringify(content), ownerId }
  });
}

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function listItem(text: string, children: object[] = []) {
  return { type: "listItem", content: [paragraph(text), ...children] };
}

function bulletList(...items: object[]) {
  return { type: "bulletList", content: items };
}

// The serializer backslash-escapes punctuation (e.g. "Outro\."); strip the
// escapes so assertions can compare against plain text.
async function markdownOf(documentId: string) {
  const doc = await db.document.findUniqueOrThrow({ where: { id: documentId }, select: { content: true } });
  return getDocumentMarkdown(parseDocumentContent(doc.content)).replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1");
}

async function rawMarkdownOf(documentId: string) {
  const doc = await db.document.findUniqueOrThrow({ where: { id: documentId }, select: { content: true } });
  return getDocumentMarkdown(parseDocumentContent(doc.content));
}

test("mcp edit: widget placeholder is matchable and deletable via find_text", async () => {
  const user = await makeUser();
  const widgetId = `wid-${crypto.randomUUID().slice(0, 8)}`;
  const doc = await makeDoc(user.id, {
    type: "doc",
    content: [
      paragraph("Before the widget."),
      { type: "embeddedWidget", attrs: { widgetId, label: "FFT explorer" } },
      paragraph("After the widget.")
    ]
  });

  const placeholder = `![widget: FFT explorer](widget://${widgetId})`;
  assert.ok((await markdownOf(doc.id)).includes(placeholder), "sanity: read_document shows the placeholder");

  // Delete the widget: match the exact placeholder line, replace with nothing.
  await applyMarkdownEdit({
    documentId: doc.id,
    userId: user.id,
    mode: "replace",
    markdown: "",
    findText: placeholder
  });

  const markdown = await markdownOf(doc.id);
  assert.ok(!markdown.includes("widget://"), `widget should be gone, got:\n${markdown}`);
  assert.ok(markdown.includes("Before the widget."));
  assert.ok(markdown.includes("After the widget."));
});

test("mcp edit: widget placeholder can be moved (matched with surrounding text)", async () => {
  const user = await makeUser();
  const widgetId = `wid-${crypto.randomUUID().slice(0, 8)}`;
  await db.embeddedWidget.create({
    data: {
      id: widgetId,
      documentId: (
        await makeDoc(user.id, {
          type: "doc",
          content: [
            paragraph("Intro."),
            { type: "embeddedWidget", attrs: { widgetId, label: "Plot" } },
            paragraph("Outro.")
          ]
        })
      ).id,
      label: "Plot",
      buildCmd: "true",
      embedSource: "assets/plot.html",
      workspacePath: "/tmp/nowhere"
    }
  });
  const widgetRow = await db.embeddedWidget.findUniqueOrThrow({ where: { id: widgetId } });
  const documentId = widgetRow.documentId;
  const placeholder = `![widget: Plot](widget://${widgetId})`;

  // Move = delete at old location...
  await applyMarkdownEdit({ documentId, userId: user.id, mode: "replace", markdown: "", findText: placeholder });
  // ...and re-insert after "Outro."
  await applyMarkdownEdit({
    documentId,
    userId: user.id,
    mode: "replace",
    markdown: `Outro.\n\n${placeholder}`,
    findText: "Outro."
  });

  const markdown = await markdownOf(documentId);
  const introIdx = markdown.indexOf("Intro.");
  const outroIdx = markdown.indexOf("Outro.");
  const widgetIdx = markdown.indexOf("widget://");
  assert.ok(widgetIdx > outroIdx && outroIdx > introIdx, `widget should follow Outro, got:\n${markdown}`);
  assert.equal(markdown.match(/widget:\/\//g)?.length, 1, "exactly one placeholder");
});

test("mcp edit: replacement list adds a sibling item, not a nested child", async () => {
  const user = await makeUser();
  const doc = await makeDoc(user.id, {
    type: "doc",
    content: [bulletList(listItem("item A"), listItem("item C"))]
  });

  await applyMarkdownEdit({
    documentId: doc.id,
    userId: user.id,
    mode: "replace",
    markdown: "- item A\n- item B",
    findText: "item A"
  });

  const markdown = await markdownOf(doc.id);
  assert.match(markdown, /^- item A$/m, `item A top-level, got:\n${markdown}`);
  assert.match(markdown, /^- item B$/m, `item B must be a SIBLING (top-level), got:\n${markdown}`);
  assert.match(markdown, /^- item C$/m);
});

test("mcp edit: a nested item can be de-nested (multi-item list rewrite)", async () => {
  const user = await makeUser();
  const doc = await makeDoc(user.id, {
    type: "doc",
    content: [bulletList(listItem("item A", [bulletList(listItem("item B"))]), listItem("item C"))]
  });

  // find_text copied from read_document markdown, spanning two items with markers.
  await applyMarkdownEdit({
    documentId: doc.id,
    userId: user.id,
    mode: "replace",
    markdown: "- item A\n- item B",
    findText: "- item A\n  - item B"
  });

  const markdown = await markdownOf(doc.id);
  assert.match(markdown, /^- item A$/m, `got:\n${markdown}`);
  assert.match(markdown, /^- item B$/m, `item B must be de-nested, got:\n${markdown}`);
  assert.match(markdown, /^- item C$/m);
});

test("mcp edit: find_text can span paragraph breaks and heading markers", async () => {
  const user = await makeUser();
  const doc = await makeDoc(user.id, {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Old heading" }] },
      paragraph("First paragraph."),
      paragraph("Second paragraph.")
    ]
  });

  // Copied from read_document markdown: heading marker + blank lines included.
  await applyMarkdownEdit({
    documentId: doc.id,
    userId: user.id,
    mode: "replace",
    markdown: "## New heading\n\nMerged paragraph.",
    findText: "## Old heading\n\nFirst paragraph.\n\nSecond paragraph."
  });

  const markdown = await markdownOf(doc.id);
  assert.ok(markdown.includes("## New heading"), `got:\n${markdown}`);
  assert.ok(markdown.includes("Merged paragraph."));
  assert.ok(!markdown.includes("Old heading"));
  assert.ok(!markdown.includes("First paragraph."));
});

test("mcp edit: find_text with markdown escapes from read_document matches", async () => {
  const user = await makeUser();
  const doc = await makeDoc(user.id, {
    type: "doc",
    content: [paragraph("Use plot.py (v2) - it works!")]
  });

  // read_document serializes this as "Use plot\.py \(v2\) \- it works\!"
  const escaped = (await rawMarkdownOf(doc.id)).trim();
  assert.ok(escaped.includes("\\"), `sanity: serializer escapes specials, got: ${escaped}`);

  await applyMarkdownEdit({
    documentId: doc.id,
    userId: user.id,
    mode: "replace",
    markdown: "Escapes resolved.",
    findText: escaped
  });

  assert.ok((await markdownOf(doc.id)).includes("Escapes resolved."));
});

test("mcp edit: empty replacement on plain text deletes the block", async () => {
  const user = await makeUser();
  const doc = await makeDoc(user.id, {
    type: "doc",
    content: [paragraph("Keep me."), paragraph("Delete me."), paragraph("Keep me too.")]
  });

  await applyMarkdownEdit({
    documentId: doc.id,
    userId: user.id,
    mode: "replace",
    markdown: "",
    findText: "Delete me."
  });

  const markdown = await markdownOf(doc.id);
  assert.ok(!markdown.includes("Delete me."));
  assert.ok(markdown.includes("Keep me."));
  assert.ok(markdown.includes("Keep me too."));
});

test("mcp edit: empty markdown on append still errors", async () => {
  const user = await makeUser();
  const doc = await makeDoc(user.id, { type: "doc", content: [paragraph("Hi.")] });
  await assert.rejects(
    applyMarkdownEdit({ documentId: doc.id, userId: user.id, mode: "append", markdown: "   " }),
    McpEditError
  );
});
