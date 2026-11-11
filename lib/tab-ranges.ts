import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transform } from "@tiptap/pm/transform";

// A tab is a top-level `tabBreak` plus every top-level block up to the next
// tabBreak (or the end of the document). Deleting a tab means deleting that whole
// slice — deleting only the break silently merged the tab's content into the
// previous tab (2026-11-11). Pure (no editor), shared by the outline's delete
// button, MCP edits and accepting a tracked tab deletion.

export type TabRange = { from: number; to: number };

// [from, to) of the tab whose break sits at top-level position `breakPos`.
export function tabRangeAtBreak(doc: ProseMirrorNode, breakPos: number): TabRange | null {
  const node = doc.nodeAt(breakPos);
  if (!node || node.type.name !== "tabBreak") return null;
  let to = doc.content.size;
  let found = false;
  doc.forEach((child, offset) => {
    if (found || offset <= breakPos) return;
    if (child.type.name === "tabBreak") {
      to = offset;
      found = true;
    }
  });
  return { from: breakPos, to };
}

export function findTabBreakPosById(doc: ProseMirrorNode, tabId: string): number | null {
  let pos: number | null = null;
  doc.forEach((child, offset) => {
    if (pos === null && child.type.name === "tabBreak" && child.attrs?.tabId === tabId) pos = offset;
  });
  return pos;
}

// Removes the tab at `breakPos` with all its content. Deleting the document's
// only content leaves one empty paragraph (a doc must hold a block).
export function deleteTabAtBreak(tr: Transform, breakPos: number): boolean {
  const range = tabRangeAtBreak(tr.doc, breakPos);
  if (!range) return false;
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  if (range.from === 0 && range.to === tr.doc.content.size && paragraph) {
    tr.replaceWith(range.from, range.to, paragraph.create());
  } else {
    tr.delete(range.from, range.to);
  }
  return true;
}

export function deleteTabById(tr: Transform, tabId: string): boolean {
  const pos = findTabBreakPosById(tr.doc, tabId);
  return pos === null ? false : deleteTabAtBreak(tr, pos);
}
