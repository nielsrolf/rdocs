import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";

import { SUGGESTED_DELETION_MARK, SUGGESTED_INSERTION_MARK } from "@/lib/suggestion-content";
import type { SuggestionAuthor } from "./suggestions";

// Applies an AGENT's anchored find/replace suggestions to the live editor as
// tracked-change marks. The agent only emits document text, so each suggestion
// is resolved here: findText is located in the document's flattened text (the
// same basis the server validated against — see lib/suggestion-content.
// flattenDocumentTextNodes), and the matched range is struck (suggestedDeletion)
// while the replacement is inserted right after it (suggestedInsertion). A human
// then accepts or rejects via the suggestions module.

export type AgentSuggestionInput = {
  findText: string;
  replacementText: string;
  reason?: string;
};

type FlatIndex = {
  flat: string;
  segments: Array<{ flatStart: number; pos: number; length: number }>;
};

function buildFlatIndex(doc: PMNode): FlatIndex {
  let flat = "";
  const segments: FlatIndex["segments"] = [];
  doc.descendants((node, pos) => {
    if (node.isText && typeof node.text === "string") {
      segments.push({ flatStart: flat.length, pos, length: node.text.length });
      flat += node.text;
    }
  });
  return { flat, segments };
}

function flatOffsetToPos(index: FlatIndex, offset: number): number | null {
  for (const seg of index.segments) {
    if (offset >= seg.flatStart && offset <= seg.flatStart + seg.length) {
      return seg.pos + (offset - seg.flatStart);
    }
  }
  return null;
}

// Locates findText in the document. Returns null when it is absent OR not unique
// (the document drifted since the agent ran) — the caller skips and reports it
// rather than risk editing the wrong place.
export function resolveSuggestionRange(
  doc: PMNode,
  findText: string
): { from: number; to: number } | null {
  if (!findText) return null;
  const index = buildFlatIndex(doc);
  const first = index.flat.indexOf(findText);
  if (first === -1) return null;
  if (index.flat.indexOf(findText, first + findText.length) !== -1) return null;
  const from = flatOffsetToPos(index, first);
  const to = flatOffsetToPos(index, first + findText.length);
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

// Replaces a known range with a tracked-change suggestion: the range is struck
// (suggestedDeletion) and `replacementText` is inserted right after it
// (suggestedInsertion), sharing one suggestion id so a single accept performs the
// whole replacement. Used for suggest-only selection edits (a comment-access user
// asked the agent to edit their selection — the result lands as a suggestion).
export function buildRangeSuggestionTransaction(
  state: EditorState,
  range: { from: number; to: number },
  replacementText: string,
  author: SuggestionAuthor
): Transaction | null {
  const insMark = state.schema.marks[SUGGESTED_INSERTION_MARK];
  const delMark = state.schema.marks[SUGGESTED_DELETION_MARK];
  if (!insMark || !delMark) return null;

  const docSize = state.doc.content.size;
  const from = Math.max(0, Math.min(range.from, docSize));
  const to = Math.max(from, Math.min(range.to, docSize));
  const replacement = replacementText.replace(/\r?\n+/g, " ").trim();
  if (to <= from && !replacement) return null;

  const tr = state.tr;
  const attrs = {
    suggestionId: makeSuggestionId(),
    authorId: author.authorId,
    authorLabel: author.authorLabel,
    createdAt: new Date().toISOString()
  };
  if (to > from) {
    tr.addMark(from, to, delMark.create(attrs));
  }
  if (replacement) {
    tr.insert(to, state.schema.text(replacement, [insMark.create(attrs)]));
  }
  return tr;
}
