import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { getDocumentMarkdown, parseDocumentContent } from "../lib/content";
import { db } from "../lib/db";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import { TABLE_AUTO_COLUMN_MIN_WIDTH } from "../lib/document-table";
import { applyMarkdownEdit } from "../lib/mcp/apply-edit";

// Tables scroll horizontally and their columns can be dragged to a width
// (2026-11-16). The width lives in the cells' `colwidth` attr; these tests pin
// what the server does with it.

function cell(type: "tableHeader" | "tableCell", text: string, width?: number) {
  return {
    type,
    attrs: { colspan: 1, rowspan: 1, colwidth: width ? [width] : null },
    content: [{ type: "paragraph", content: [{ type: "text", text }] }]
  };
}

const SIZED_TABLE = {
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        { type: "tableRow", content: [cell("tableHeader", "Eval", 300), cell("tableHeader", "Status", 90)] },
        { type: "tableRow", content: [cell("tableCell", "toxicity", 300), cell("tableCell", "Done", 90)] }
      ]
    }
  ]
};

type TableJson = { content: Array<{ content: Array<{ attrs: { colwidth: number[] | null } }> }> };

test("column widths: the server schema keeps colwidth and renders a scroll wrapper", () => {
  const schema = createDocumentEditorSchema();
  const doc = schema.nodeFromJSON(SIZED_TABLE);
  doc.check();
  const table = doc.firstChild!;
  assert.deepEqual(table.firstChild!.firstChild!.attrs.colwidth, [300]);

  // Sized columns give the table a fixed width (wider than the page = scroll).
  const sized = schema.nodes.table.spec.toDOM!(table) as unknown as [string, { class: string }, [string, { style: string }]];
  assert.equal(sized[0], "div");
  assert.equal(sized[1].class, "tableWrapper");
  assert.equal(sized[2][1].style, "width: 390px");

  // Unsized columns each count for the auto minimum, so many columns overflow.
  const unsized = schema.nodeFromJSON({
    type: "table",
    content: [{ type: "tableRow", content: Array.from({ length: 10 }, (_, i) => cell("tableCell", `c${i}`)) }]
  });
  const auto = schema.nodes.table.spec.toDOM!(unsized) as unknown as [string, unknown, [string, { style: string }]];
  assert.equal(auto[2][1].style, `min-width: ${10 * TABLE_AUTO_COLUMN_MIN_WIDTH}px`);
});

test("column widths: an agent row edit keeps the widths and markdown ignores them", async () => {
  const user = await db.user.create({
    data: { email: `table-width-${crypto.randomUUID()}@example.com`, name: "table-width", passwordHash: "x" }
  });
  const doc = await db.document.create({
    data: { title: "Table widths", content: JSON.stringify(SIZED_TABLE), ownerId: user.id }
  });
  await applyMarkdownEdit({
    documentId: doc.id,
    userId: user.id,
    mode: "replace",
    findText: "| toxicity | Done |",
    markdown: "| toxicity | Rerun |\n| bias | Planned |"
  });

  const saved = await db.document.findUniqueOrThrow({ where: { id: doc.id }, select: { content: true } });
  const content = parseDocumentContent(saved.content) as unknown as { content: TableJson[] };
  const rows = content.content[0].content;
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.deepEqual(row.content.map((c) => c.attrs.colwidth), [[300], [90]]);
  }
  assert.match(getDocumentMarkdown(parseDocumentContent(saved.content)), /\| toxicity \| Rerun \|\n\| bias \| Planned \|/);
});
