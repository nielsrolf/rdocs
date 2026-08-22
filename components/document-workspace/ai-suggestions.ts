import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";

import { SUGGESTED_DELETION_MARK, SUGGESTED_INSERTION_MARK, findAnchorMatch } from "@/lib/suggestion-content";
import type { SuggestionAuthor } from "./suggestions";

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
