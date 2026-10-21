import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";

import { insertBlocksAfterRange } from "@/lib/structured-replace";
import { SUGGESTED_DELETION_MARK, SUGGESTED_INSERTION_MARK, findAnchorMatch } from "@/lib/suggestion-content";
import { addSuggestionMarks, type SuggestionAuthor, type SuggestionRecord } from "./suggestions";

// Applies an AGENT's anchored find/replace suggestions to the live editor as
// tracked-change marks. The agent only emits document text, so each suggestion
// is resolved here: findText is located in the document's flattened ANCHOR text
// — the same basis the server validated against (lib/suggestion-content.
// flattenDocumentAnchorText: text nodes joined with "\n" at parent-node
// boundaries, hardBreak as "\n") using the same tolerant matcher
// (findAnchorMatch) — and the matched range is struck (suggestedDeletion) while
// the replacement is inserted right after it (suggestedInsertion). A human then
// accepts or rejects via the suggestions module. Lockstep is guarded by
// tests/anchor-matching.test.ts.

export type AgentSuggestionInput = {
  findText: string;
  replacementText: string;
  reason?: string;
};

type FlatIndex = {
  flat: string;
  // For each character of `flat`: the document position of that character, or
  // -1 for synthetic block-separator newlines that have no document position.
  posMap: number[];
};

function buildFlatIndex(doc: PMNode): FlatIndex {
  let flat = "";
  const posMap: number[] = [];
  let lastParent: PMNode | null = null;
  doc.descendants((node, pos, parent) => {
    if (node.isText && typeof node.text === "string") {
      if (flat.length > 0 && parent !== lastParent && !flat.endsWith("\n")) {
        flat += "\n";
        posMap.push(-1);
      }
      for (let k = 0; k < node.text.length; k += 1) {
        flat += node.text[k];
        posMap.push(pos + k);
      }
      lastParent = parent;
      return;
    }
    if (node.type.name === "hardBreak") {
      if (flat.length > 0 && !flat.endsWith("\n")) {
        flat += "\n";
        posMap.push(pos);
      }
      lastParent = parent;
    }
  });
  return { flat, posMap };
}

// Locates findText in the document via the shared tolerant matcher. Returns null
// when it is absent OR not unique (the document drifted since the agent ran) —
// the caller skips and reports it rather than risk editing the wrong place.
export function resolveSuggestionRange(
  doc: PMNode,
  findText: string
): { from: number; to: number } | null {
  if (!findText) return null;
  const index = buildFlatIndex(doc);
  const match = findAnchorMatch(index.flat, findText);
  if (match.count !== 1) return null;
  // Skip synthetic separators at the boundaries: the range must start and end on
  // real document characters.
  let startIdx = match.start;
  while (startIdx < match.end && index.posMap[startIdx] === -1) startIdx += 1;
  let endIdx = match.end - 1;
  while (endIdx >= startIdx && index.posMap[endIdx] === -1) endIdx -= 1;
  if (endIdx < startIdx) return null;
  const from = index.posMap[startIdx];
  const to = index.posMap[endIdx] + 1;
  if (from == null || to == null || to < from) return null;
  return { from, to };
}

function makeSuggestionId(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  return `sg-${rand}`;
}

export type AiSuggestionApplyResult = {
  tr: Transaction | null;
  applied: number;
  skipped: AgentSuggestionInput[];
};

// Resolves every suggestion against the CURRENT state, then applies them in ONE
// transaction back-to-front (highest position first) so earlier offsets stay
// valid. Returns the transaction (or null when nothing resolved) plus the list
// of suggestions that could not be placed.
export function buildAiSuggestionsTransaction(
  state: EditorState,
  suggestions: AgentSuggestionInput[],
  author: SuggestionAuthor
): AiSuggestionApplyResult {
  const insMark = state.schema.marks[SUGGESTED_INSERTION_MARK];
  const delMark = state.schema.marks[SUGGESTED_DELETION_MARK];
  if (!insMark || !delMark) return { tr: null, applied: 0, skipped: suggestions };

  type Resolved = { from: number; to: number; replacement: string };
  const resolved: Resolved[] = [];
  const skipped: AgentSuggestionInput[] = [];

  for (const suggestion of suggestions) {
    const range = resolveSuggestionRange(state.doc, suggestion.findText);
    if (!range) {
      skipped.push(suggestion);
      continue;
    }
    // Inline insertion: collapse newlines so the replacement is a valid text run.
    const replacement = suggestion.replacementText.replace(/\r?\n+/g, " ").trim();
    resolved.push({ from: range.from, to: range.to, replacement });
  }

  if (resolved.length === 0) {
    return { tr: null, applied: 0, skipped };
  }

  const tr = state.tr;
  const createdAt = new Date().toISOString();
  // High → low so insertions/marks at later positions don't shift earlier ones.
  resolved.sort((a, b) => b.from - a.from);
  for (const op of resolved) {
    const suggestionId = makeSuggestionId();
    const attrs = {
      suggestionId,
      authorId: author.authorId,
      authorLabel: author.authorLabel,
      createdAt
    };
    if (op.to > op.from) {
      tr.addMark(op.from, op.to, delMark.create(attrs));
    }
    if (op.replacement) {
      tr.insert(op.to, state.schema.text(op.replacement, [insMark.create(attrs)]));
    }
  }

  return { tr, applied: resolved.length, skipped };
}

// Tracked replacement of a KNOWN range with rich block content (an agent
// suggestion, or a selection edit in direct mode): the range is struck and the
// content is spliced in right after it via lib/structured-replace, so a bullet
// rewritten as "**Label:** text" stays ONE bullet instead of "bullet, blank
// line, text". When the content has block structure and the range ends
// mid-text, the strike is widened to the end of that textblock and its tail is
// re-inserted after the content — otherwise rejecting would leave the paragraph
// split in two. Pure (no editor), so tests drive it directly.
export function buildRichTrackedReplacementTransaction(
  state: EditorState,
  range: { from: number; to: number },
  content: Fragment,
  record: SuggestionRecord
): Transaction | null {
  const tr = state.tr;
  let deletionTo = range.to;
  const nodes: PMNode[] = [];
  content.forEach((node) => nodes.push(node));
  while (nodes.length > 0 && isEmptyParagraph(nodes[0])) nodes.shift();
  while (nodes.length > 0 && isEmptyParagraph(nodes[nodes.length - 1])) nodes.pop();

  const $to = state.doc.resolve(range.to);
  const inlineOnly = nodes.length === 1 && nodes[0].type.name === "paragraph";
  if (nodes.length > 0 && !inlineOnly && $to.parent.isTextblock && range.to < $to.end()) {
    const tailContent = $to.parent.content.cut($to.parentOffset);
    const tail = stripSuggestionMarks(tailContent);
    const last = nodes[nodes.length - 1];
    if (last.type.name === "paragraph") {
      nodes[nodes.length - 1] = last.copy(last.content.append(tail));
    } else {
      nodes.push(state.schema.nodes.paragraph.create(null, tail));
    }
    deletionTo = $to.end();
  }

  const inserted = nodes.length > 0 ? insertBlocksAfterRange(tr, range.from, deletionTo, nodes) : [];
  if (deletionTo > range.from) addSuggestionMarks(tr, { from: range.from, to: deletionTo }, "delete", record);
  for (const span of inserted) addSuggestionMarks(tr, span, "insert", record);
  return tr.docChanged ? tr : null;
}

function isEmptyParagraph(node: PMNode) {
  return node.type.name === "paragraph" && node.content.size === 0;
}

function stripSuggestionMarks(fragment: Fragment): Fragment {
  const names = new Set([SUGGESTED_INSERTION_MARK, SUGGESTED_DELETION_MARK]);
  const nodes: PMNode[] = [];
  fragment.forEach((node) => {
    nodes.push(node.mark(node.marks.filter((mark) => !names.has(mark.type.name))));
  });
  return Fragment.fromArray(nodes);
}
