import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { getDocumentMarkdown, parseDocumentContent } from "../lib/content";
import { db } from "../lib/db";
import { applyMarkdownEdit, McpEditError } from "../lib/mcp/apply-edit";

// Reported by agents (2026-11-12): "the doc editor only replaces within one
// cell" — a table row copied from read_document (`| a | b |`) never matched, and
// a match spanning cells dumped the replacement into the first cell. Rows are
// now editable as rows.

function paragraph(text: string) {
  return text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };
}

function row(type: "tableHeader" | "tableCell", ...cells: string[]) {
  return { type: "tableRow", content: cells.map((text) => ({ type, content: [paragraph(text)] })) };
}

const STATUS_TABLE = {
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

async function makeDoc(content: object = STATUS_TABLE) {
  const user = await db.user.create({
    data: { email: `mcp-table-${crypto.randomUUID()}@example.com`, name: "mcp-table", passwordHash: "x" }
  });
  const doc = await db.document.create({
    data: { title: "MCP table test", content: JSON.stringify(content), ownerId: user.id }
  });
  return { user, doc };
}

async function contentOf(documentId: string) {
  const doc = await db.document.findUniqueOrThrow({ where: { id: documentId }, select: { content: true } });
  return parseDocumentContent(doc.content) as { content: Array<{ type: string; content?: unknown[] }> };
}

async function markdownOf(documentId: string) {
  const doc = await db.document.findUniqueOrThrow({ where: { id: documentId }, select: { content: true } });
  return getDocumentMarkdown(parseDocumentContent(doc.content)).replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1");
}

async function edit(documentId: string, userId: string, findText: string, markdown: string) {
  return applyMarkdownEdit({ documentId, userId, mode: "replace", findText, markdown });
}

function tableLines(markdown: string) {
  return markdown.split("\n").filter((line) => line.startsWith("|"));
}

test("table edit: a row copied from read_document is replaced as a row", async () => {
  const { user, doc } = await makeDoc();
  await edit(doc.id, user.id, "| hate speech | In progress |", "| hate speech | Evaluated on 3 models |");

  const markdown = await markdownOf(doc.id);
  assert.deepEqual(tableLines(markdown), [
    "| Eval | Status |",
    "| --- | --- |",
    "| toxicity | Done |",
    "| hate speech | Evaluated on 3 models |",
    "| hallucinations | In progress |"
  ]);
  const content = await contentOf(doc.id);
  assert.deepEqual(content.content.map((node) => node.type), ["paragraph", "table", "paragraph"]);
});

test("table edit: several rows can be replaced, added to and keep their cell types", async () => {
  const { user, doc } = await makeDoc();
  await edit(
    doc.id,
    user.id,
    "| hate speech | In progress |\n| hallucinations | In progress |",
    "| hate speech | Done |\n| hallucinations | Done |\n| bias | Planned |"
  );

  assert.deepEqual(tableLines(await markdownOf(doc.id)), [
    "| Eval | Status |",
    "| --- | --- |",
    "| toxicity | Done |",
    "| hate speech | Done |",
    "| hallucinations | Done |",
    "| bias | Planned |"
  ]);
  const table = (await contentOf(doc.id)).content[1] as { content: Array<{ content: Array<{ type: string }> }> };
  assert.deepEqual(
    table.content.map((tableRow) => tableRow.content[0].type),
    ["tableHeader", "tableCell", "tableCell", "tableCell", "tableCell"]
  );
});

test("table edit: the whole table copied with its delimiter row can be replaced, columns included", async () => {
  const { user, doc } = await makeDoc();
  const before = tableLines(await markdownOf(doc.id)).join("\n");
  await edit(
    doc.id,
    user.id,
    before,
    "| Eval | Status | Owner |\n| --- | --- | --- |\n| toxicity | Done | A |\n| bias | Planned | B |"
  );

  assert.deepEqual(tableLines(await markdownOf(doc.id)), [
    "| Eval | Status | Owner |",
    "| --- | --- | --- |",
    "| toxicity | Done | A |",
    "| bias | Planned | B |"
  ]);
  const content = await contentOf(doc.id);
  assert.deepEqual(content.content.map((node) => node.type), ["paragraph", "table", "paragraph"]);
});

test("table edit: the header row echoed with the delimiter is not duplicated", async () => {
  const { user, doc } = await makeDoc();
  await edit(
    doc.id,
    user.id,
    "| Eval | Status |\n| --- | --- |\n| toxicity | Done |",
    "| Eval | Result |\n| --- | --- |\n| toxicity | Passed |"
  );
  assert.deepEqual(tableLines(await markdownOf(doc.id)), [
    "| Eval | Result |",
    "| --- | --- |",
    "| toxicity | Passed |",
    "| hate speech | In progress |",
    "| hallucinations | In progress |"
  ]);
});

test("table edit: replacing a row with nothing deletes the row", async () => {
  const { user, doc } = await makeDoc();
  await edit(doc.id, user.id, "| hallucinations | In progress |", "");
  assert.deepEqual(tableLines(await markdownOf(doc.id)), [
    "| Eval | Status |",
    "| --- | --- |",
    "| toxicity | Done |",
    "| hate speech | In progress |"
  ]);
});

test("table edit: a short row is padded, a row with too many cells is refused", async () => {
  const { user, doc } = await makeDoc();
  await edit(doc.id, user.id, "| hallucinations | In progress |", "| hallucinations |");
  assert.equal(tableLines(await markdownOf(doc.id))[4], "| hallucinations |  |");

  await assert.rejects(
    edit(doc.id, user.id, "| hate speech | In progress |", "| hate speech | Done | extra |"),
    (error: unknown) => error instanceof McpEditError && /2 columns/.test(error.message)
  );
});

test("table edit: a match spanning cells with non-row content is refused instead of mangling the table", async () => {
  const { user, doc } = await makeDoc();
  const before = await markdownOf(doc.id);
  await assert.rejects(
    edit(doc.id, user.id, "hate speech\nIn progress", "hate speech: evaluated on 3 models"),
    (error: unknown) => error instanceof McpEditError && /row/.test(error.message)
  );
  assert.equal(await markdownOf(doc.id), before);
});

test("table edit: a single cell is still edited in place", async () => {
  const { user, doc } = await makeDoc();
  await edit(doc.id, user.id, "hallucinations", "hallucinations (v2)");
  assert.equal(tableLines(await markdownOf(doc.id))[4], "| hallucinations (v2) | In progress |");
});

test("table edit: pipe-row text outside a table still matches as text", async () => {
  const { user, doc } = await makeDoc({
    type: "doc",
    content: [paragraph("Use | to pipe."), paragraph("Other.")]
  });
  await edit(doc.id, user.id, "Use | to pipe.", "Use a pipe.");
  assert.match(await markdownOf(doc.id), /Use a pipe\./);
});
