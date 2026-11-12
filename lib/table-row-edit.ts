import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import type { Transform } from "@tiptap/pm/transform";

// Row-level table edits for agent markdown (MCP replace_in_document).
//
// A table is read as GFM (`| a | b |` lines), so an agent edits it by copying
// rows and writing rows back. Without this a row never matched (the pipes are not
// document text), and a text match spanning cells was spliced as prose: the
// replacement landed in the first cell and the other cells kept their old text
// ("the doc editor only replaces within one cell", 2026-11-12).

const PIPE_ROW = /^\s*\|.*\|\s*$/;
const DELIMITER_ROW = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;

export class TableRowEditError extends Error {}

function nonBlankLines(markdown: string) {
  return markdown.split("\n").filter((line) => line.trim() !== "");
}

/** Cells of one `| a | b |` line (unescaped `|` separates, `\|` is a literal pipe). */
export function splitPipeRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === "\\" && inner[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (inner[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += inner[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

/** True when every non-blank line is a table row (`| … |`). */
export function isPipeRows(markdown: string): boolean {
  const lines = nonBlankLines(markdown);
  return lines.length > 0 && lines.every((line) => PIPE_ROW.test(line));
}

/**
 * find_text copied from a markdown table → the document text it stands for: cells
 * become separate lines (cell boundaries are block boundaries in the text index)
 * and the `| --- |` delimiter row, which is not in the document, is dropped.
 * Returns null when no line is a table row.
 */
export function pipeRowsToCellText(needle: string): string | null {
  let changed = false;
  const lines: string[] = [];
  for (const line of needle.split("\n")) {
    if (!PIPE_ROW.test(line)) {
      lines.push(line);
      continue;
    }
    changed = true;
    if (DELIMITER_ROW.test(line)) continue;
    lines.push(splitPipeRow(line).join("\n"));
  }
  return changed ? lines.join("\n") : null;
}

/**
 * Replacement rows as a parseable GFM table. Rows without a header delimiter
 * (`| a | b |` on its own is a paragraph to markdown-it) get one synthesized;
 * `explicitHeader` says whether the author wrote the delimiter themself.
 */
export function pipeRowsAsTableMarkdown(markdown: string): { markdown: string; explicitHeader: boolean } | null {
  if (!isPipeRows(markdown)) return null;
  const lines = nonBlankLines(markdown);
  if (lines.length > 1 && DELIMITER_ROW.test(lines[1])) {
    return { markdown: lines.join("\n"), explicitHeader: true };
  }
  const rows = lines.filter((line) => !DELIMITER_ROW.test(line));
  if (rows.length === 0) return null;
  // GFM truncates body rows to the header's width, so the header is padded to
  // the widest row.
  const width = Math.max(...rows.map((line) => splitPipeRow(line).length));
  const firstCells = splitPipeRow(rows[0]).length;
  const first = `${rows[0].trim()}${" |".repeat(width - firstCells)}`;
  const delimiter = `|${" --- |".repeat(width)}`;
  return { markdown: [first, delimiter, ...rows.slice(1)].join("\n"), explicitHeader: false };
}

export type TableRowSpan = {
  table: PMNode;
  tablePos: number;
  /** First matched row and the row after the last matched one. */
  startRow: number;
  endRow: number;
  /** The range touches more than one cell. */
  multiCell: boolean;
  /** Nothing in the matched rows lies outside the range. */
  wholeRows: boolean;
  wholeTable: boolean;
};

/** The table rows a range lies in, or null when it is not inside ONE table. */
export function tableRowSpan(doc: PMNode, from: number, to: number): TableRowSpan | null {
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  for (let depth = Math.min($from.depth, $to.depth) - 2; depth >= 0; depth -= 1) {
    const table = $from.node(depth);
    if (table.type.name !== "table") continue;
    if ($to.node(depth) !== table || $to.start(depth) !== $from.start(depth)) return null;
    const startRow = $from.index(depth);
    const endRow = $to.index(depth) + 1;
    const multiCell = endRow - startRow > 1 || $from.index(depth + 1) !== $to.index(depth + 1);
    const blank = (a: number, b: number) => doc.textBetween(a, b, "", "￼") === "";
    const wholeRows = blank($from.start(depth + 1), from) && blank(to, $to.end(depth + 1));
    return {
      table,
      tablePos: $from.before(depth),
      startRow,
      endRow,
      multiCell,
      wholeRows,
      wholeTable: wholeRows && startRow === 0 && endRow === table.childCount
    };
  }
  return null;
}

function hasMergedCells(table: PMNode) {
  let merged = false;
  table.descendants((node) => {
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
      if ((node.attrs.colspan ?? 1) !== 1 || (node.attrs.rowspan ?? 1) !== 1) merged = true;
      return false;
    }
    return !merged;
  });
  return merged;
}

function rowOffset(table: PMNode, tablePos: number, row: number) {
  let pos = tablePos + 1;
  for (let i = 0; i < row; i += 1) pos += table.child(i).nodeSize;
  return pos;
}

function rowText(row: PMNode) {
  const cells: string[] = [];
  row.forEach((cell) => cells.push(cell.textContent.trim()));
  return cells.join("\u0000");
}

/** Delete the matched rows (the whole table when all of them are matched). */
export function deleteTableRows(tr: Transform, span: TableRowSpan) {
  if (span.wholeTable) {
    tr.delete(span.tablePos, span.tablePos + span.table.nodeSize);
    return;
  }
  tr.delete(rowOffset(span.table, span.tablePos, span.startRow), rowOffset(span.table, span.tablePos, span.endRow));
}

/**
 * Replace the matched rows with the rows of `replacement` (a table node). New
 * cells take the node type and attrs (header-ness, column width) of the cell
 * they replace; short rows are padded, wider rows are refused unless the whole
 * table is replaced.
 */
export function replaceTableRows(
  tr: Transform,
  span: TableRowSpan,
  replacement: PMNode,
  options: { explicitHeader: boolean }
) {
  const { table, tablePos, startRow, endRow } = span;
  if (span.wholeTable) {
    tr.replaceWith(tablePos, tablePos + table.nodeSize, replacement);
    return;
  }
  if (hasMergedCells(table)) {
    throw new TableRowEditError(
      "This table has merged cells, so its rows cannot be replaced one by one. Edit the text inside one cell at a time, or replace the whole table."
    );
  }

  const newRows: PMNode[] = [];
  replacement.forEach((row) => newRows.push(row));
  // A header row echoed for context above body rows is not a new row.
  if (options.explicitHeader && startRow > 0 && newRows.length > 1 && rowText(newRows[0]) === rowText(table.child(0))) {
    newRows.shift();
  }

  const columns = table.child(0).childCount;
  const schema = table.type.schema;
  const built = newRows.map((newRow, index) => {
    // Trailing empty cells are padding (markdown-it pads to the header width).
    let used = newRow.childCount;
    while (used > columns && newRow.child(used - 1).textContent.trim() === "") used -= 1;
    if (used > columns) {
      throw new TableRowEditError(
        `A replacement row has ${used} cells but the table has ${columns} columns. Give each row ${columns} cells, or replace the whole table (copy it from its header row to its last row) to change its columns.`
      );
    }
    const added = startRow + index >= endRow;
    const template = table.child(Math.min(startRow + index, endRow - 1));
    const cells: PMNode[] = [];
    for (let column = 0; column < columns; column += 1) {
      const old = template.child(Math.min(column, template.childCount - 1));
      // Rows added below a matched header row are body rows.
      const type = added && old.type.name === "tableHeader" ? schema.nodes.tableCell : old.type;
      const content = column < used ? newRow.child(column).content : Fragment.from(schema.nodes.paragraph.create());
      cells.push(type.create(type === old.type ? old.attrs : null, content));
    }
    return template.type.create(template.attrs, cells);
  });

  tr.replaceWith(
    rowOffset(table, tablePos, startRow),
    rowOffset(table, tablePos, endRow),
    Fragment.fromArray(built)
  );
}
