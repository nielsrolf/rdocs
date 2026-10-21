import { Fragment, Slice, type Node as PMNode, type ResolvedPos } from "@tiptap/pm/model";
import type { Transform } from "@tiptap/pm/transform";

// Structure-aware splicing of agent-produced BLOCK content (markdown → nodes)
// into a document range. Shared by every path an agent edit takes:
//   - MCP replace_in_document (lib/mcp/apply-edit.ts buildEditSteps),
//   - selection edits (document-workspace.tsx applyAiEditResult),
//   - tracked-change suggestions (ai-suggestions.ts buildRichTrackedReplacementTransaction).
//
// Why: a ProseMirror replace of a CLOSED block slice at a text position splits the
// surrounding textblock, so "<p>new</p>" dropped onto a bullet's text became
// listItem(paragraph(""), paragraph("new"), paragraph("")) — the "bullet, blank
// line, text" shape (2026-10-21). Rules, per side of the range:
//   - a paragraph at that edge of the content is OPENED: its inline content joins
//     the surrounding textblock (no split, the textblock keeps its type);
//   - any other block at that edge snaps the range edge out to the textblock
//     boundary when the edge sits at the start/end of the textblock (no empty half
//     is left behind), and only splits genuinely mid-text;
//   - a list replacing whole list items becomes sibling items of that list;
//   - tab breaks only exist at the top level: from a nested position the content
//     from the first tab break on is inserted after the top-level ancestor block.

const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);
const LIST_ITEM_TYPES = new Set(["listItem", "taskItem"]);
const TAB_BREAK = "tabBreak";

export type SplicedRange = { from: number; to: number };

function toNodes(content: Fragment | readonly PMNode[]): PMNode[] {
  if (Array.isArray(content)) return [...content];
  const nodes: PMNode[] = [];
  (content as Fragment).forEach((node) => nodes.push(node));
  return nodes;
}

function isEmptyParagraph(node: PMNode) {
  return node.type.name === "paragraph" && node.content.size === 0;
}

// Leading/trailing empty paragraphs carry nothing and would become blank lines.
function trimEmptyEdges(nodes: PMNode[]): PMNode[] {
  let start = 0;
  let end = nodes.length;
  while (start < end && isEmptyParagraph(nodes[start])) start += 1;
  while (end > start && isEmptyParagraph(nodes[end - 1])) end -= 1;
  return nodes.slice(start, end);
}

function isParagraph(node: PMNode | undefined) {
  return node?.type.name === "paragraph";
}

function isFirstLineOfListItem($pos: ResolvedPos) {
  const depth = $pos.depth - 1;
  return depth >= 0 && LIST_ITEM_TYPES.has($pos.node(depth).type.name) && $pos.index(depth) === 0;
}

// Position of the edge of [from,to]'s range after deciding how the content's
// boundary node meets it. Returns the (possibly moved) position and the slice
// open depth for that side.
function edgeFor(
  $pos: ResolvedPos,
  boundaryNode: PMNode,
  side: "start" | "end",
  emptyRange: boolean
): { pos: number; open: number } {
  if (!$pos.parent.isTextblock) return { pos: $pos.pos, open: 0 };
  // A paragraph merges into the surrounding textblock — unless that textblock is
  // code (inline marks/structure would be mangled) or the paragraph is empty. A
  // list item must START with a paragraph, so at the head of its first line any
  // textblock (e.g. a heading) merges in as that line instead of leaving it blank.
  const mergeable =
    isParagraph(boundaryNode) || (side === "start" && boundaryNode.isTextblock && isFirstLineOfListItem($pos));
  if (mergeable && !$pos.parent.type.spec.code && !boundaryNode.type.spec.code && boundaryNode.content.size > 0) {
    return { pos: $pos.pos, open: 1 };
  }
  const atStart = $pos.pos === $pos.start();
  const atEnd = $pos.pos === $pos.end();
  if (side === "start") {
    // Content that starts a replaced range at the very beginning of a block takes
    // the block's place; an insertion point at a block's end goes after it.
    if (atStart && !emptyRange) return { pos: $pos.before(), open: 0 };
    if (atEnd) return { pos: $pos.after(), open: 0 };
  } else {
    if (atEnd) return { pos: $pos.after(), open: 0 };
    if (atStart && emptyRange) return { pos: $pos.before(), open: 0 };
  }
  return { pos: $pos.pos, open: 0 };
}

// Whole list items replaced by a single list:
//  - the whole list matched → the new list takes its place (any list type; a
//    tracked change puts it right after the old one);
//  - one item that has sub-items → the first new item rewrites that item's line
//    (sub-items stay attached, never deleted), the rest follow as siblings;
//  - otherwise, same list type → the new items replace / follow the matched items.
function spliceListItems(
  tr: Transform,
  from: number,
  to: number,
  list: PMNode,
  keepRange: boolean
): SplicedRange[] | null {
  const doc = tr.doc;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  const coversWholeBlocks =
    $from.parent.isTextblock && $to.parent.isTextblock && from === $from.start() && to === $to.end();
  if (!coversWholeBlocks) return null;
  const range = $from.blockRange($to, (node) => LIST_TYPES.has(node.type.name));
  if (!range) return null;
  const listFrom = range.$from.before(range.depth);
  const listTo = range.$from.after(range.depth);

  if (range.startIndex === 0 && range.endIndex === range.parent.childCount) {
    if (keepRange) {
      if (range.parent.type === list.type) {
        tr.insert(range.end, list.content);
        return [{ from: range.end, to: range.end + list.content.size }];
      }
      tr.insert(listTo, list);
      return [{ from: listTo, to: listTo + list.nodeSize }];
    }
    tr.replaceWith(listFrom, listTo, list);
    return [{ from: listFrom, to: listFrom + list.nodeSize }];
  }
  if (range.parent.type !== list.type) return null;

  const matchedItem = range.parent.child(range.startIndex);
  const firstNew = list.firstChild;
  if (
    range.endIndex - range.startIndex === 1 &&
    matchedItem.childCount > 1 &&
    firstNew &&
    firstNew.childCount === 1 &&
    firstNew.firstChild?.isTextblock &&
    $to.parent === matchedItem.firstChild
  ) {
    // Rewrite the item's own line in place; its sub-items stay with it.
    const rest = list.content.cut(firstNew.nodeSize);
    const ranges: SplicedRange[] = [];
    if (rest.size > 0) {
      tr.insert(range.end, rest);
      ranges.push({ from: range.end, to: range.end + rest.size });
    }
    const line = firstNew.firstChild.content;
    if (keepRange) {
      tr.insert(to, line);
      ranges.unshift({ from: to, to: to + line.size });
      ranges.forEach((span, index) => {
        if (index > 0) {
          span.from += line.size;
          span.to += line.size;
        }
      });
    } else {
      tr.replaceWith(from, to, line);
      const delta = line.size - (to - from);
      ranges.forEach((span) => {
        span.from += delta;
        span.to += delta;
      });
      ranges.unshift({ from, to: from + line.size });
    }
    return ranges;
  }

  if (keepRange) {
    // After the last matched item, as siblings.
    const insertAt = range.end;
    if (!range.parent.canReplace(range.endIndex, range.endIndex, list.content)) return null;
    tr.insert(insertAt, list.content);
    return [{ from: insertAt, to: insertAt + list.content.size }];
  }
  if (!range.parent.canReplace(range.startIndex, range.endIndex, list.content)) return null;
  tr.replaceWith(range.start, range.end, list.content);
  return [{ from: range.start, to: range.start + list.content.size }];
}

function spliceBlocks(
  tr: Transform,
  from: number,
  to: number,
  nodes: PMNode[],
  keepRange: boolean
): SplicedRange[] {
  if (nodes.length === 0) {
    if (!keepRange && to > from) tr.deleteRange(from, to);
    return [];
  }

  if (nodes.length === 1 && LIST_TYPES.has(nodes[0].type.name)) {
    const spliced = spliceListItems(tr, from, to, nodes[0], keepRange);
    if (spliced) return spliced;
  }

  // Keeping the range (tracked change): the content goes right after it.
  const start = keepRange ? to : from;
  const doc = tr.doc;
  const $start = doc.resolve(start);
  const $end = doc.resolve(to);
  const empty = start === to;
  const head = edgeFor($start, nodes[0], "start", empty);
  let tail = edgeFor($end, nodes[nodes.length - 1], "end", empty);
  // An empty insertion point that snapped to a block boundary on one side must
  // not leave the other side open inside the textblock (or behind the start).
  if (empty && head.open === 0 && head.pos !== start) tail = { pos: head.pos, open: 0 };
  if (tail.pos < head.pos) tail = { pos: head.pos, open: 0 };

  const fragment = Fragment.fromArray(nodes);
  const slice = new Slice(fragment, head.open, tail.open);
  const stepsBefore = tr.steps.length;
  let replacedTo = tail.pos;
  try {
    tr.replace(head.pos, tail.pos, slice);
  } catch {
    replacedTo = empty ? start : to;
    tr.replaceWith(start, replacedTo, fragment);
  }
  if (tr.steps.length === stepsBefore) return [];
  const insertedTo = tr.mapping.slice(stepsBefore).map(replacedTo, 1);
  return [{ from: head.pos, to: Math.max(head.pos, insertedTo) }];
}

// Top-level (depth-1) block boundary after the block containing `pos`.
function topLevelAfter(doc: PMNode, pos: number) {
  const $pos = doc.resolve(pos);
  return $pos.depth >= 1 ? $pos.after(1) : pos;
}

function splice(
  tr: Transform,
  from: number,
  to: number,
  content: Fragment | readonly PMNode[],
  keepRange: boolean
): SplicedRange[] {
  const nodes = trimEmptyEdges(toNodes(content));
  const tabIndex = nodes.findIndex((node) => node.type.name === TAB_BREAK);
  const anchor = keepRange ? to : from;
  if (tabIndex === -1 || tr.doc.resolve(anchor).depth <= 1) {
    return spliceBlocks(tr, from, to, nodes, keepRange);
  }

  // Tab breaks must be top-level: everything from the first one on goes after
  // the top-level block that holds the range.
  const headNodes = trimEmptyEdges(nodes.slice(0, tabIndex));
  const tailNodes = nodes.slice(tabIndex);
  const tailFragment = Fragment.fromArray(tailNodes);
  const tailAt = topLevelAfter(tr.doc, to);
  tr.insert(tailAt, tailFragment);
  const tailRange = { from: tailAt, to: tailAt + tailFragment.size };
  const stepsBefore = tr.steps.length;
  const headRanges = spliceBlocks(tr, from, to, headNodes, keepRange);
  const mapping = tr.mapping.slice(stepsBefore);
  return [...headRanges, { from: mapping.map(tailRange.from, 1), to: mapping.map(tailRange.to, 1) }];
}

/** Replace [from, to) with block content, structure-aware (see file header). */
export function replaceRangeWithBlocks(
  tr: Transform,
  from: number,
  to: number,
  content: Fragment | readonly PMNode[]
): SplicedRange[] {
  return splice(tr, from, to, content, false);
}

/**
 * Insert block content right AFTER [from, to), leaving the range in place (a
 * tracked change strikes it). Returns the inserted spans (in final document
 * coordinates) — they may contain structural tokens but never pre-existing text.
 */
export function insertBlocksAfterRange(
  tr: Transform,
  from: number,
  to: number,
  content: Fragment | readonly PMNode[]
): SplicedRange[] {
  return splice(tr, from, to, content, true);
}

export function isListItemType(name: string) {
  return LIST_ITEM_TYPES.has(name);
}

export function isListType(name: string) {
  return LIST_TYPES.has(name);
}
