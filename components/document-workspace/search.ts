import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export type SearchMatch = { from: number; to: number };

type SearchState = {
  query: string;
  caseSensitive: boolean;
  matches: SearchMatch[];
  activeIndex: number;
  decorations: DecorationSet;
};

export const searchPluginKey = new PluginKey<SearchState>("document-search");

type SearchMeta = {
  query?: string;
  caseSensitive?: boolean;
  setActiveIndex?: number;
  step?: 1 | -1;
};

function findMatches(doc: ProseMirrorNode, query: string, caseSensitive: boolean): SearchMatch[] {
  const matches: SearchMatch[] = [];
  if (!query) return matches;
  const needle = caseSensitive ? query : query.toLowerCase();

  // Scan each text node independently. Matches that span node boundaries are not
  // found — acceptable for an in-document find on normal prose.
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const haystack = caseSensitive ? node.text : node.text.toLowerCase();
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      const from = pos + index;
      matches.push({ from, to: from + query.length });
      index = haystack.indexOf(needle, index + Math.max(1, query.length));
    }
  });
  return matches;
}

function buildDecorations(doc: ProseMirrorNode, matches: SearchMatch[], activeIndex: number) {
  if (matches.length === 0) return DecorationSet.empty;
  const decorations = matches.map((match, index) =>
    Decoration.inline(match.from, match.to, {
      class: index === activeIndex ? "search-match search-match-active" : "search-match"
    })
  );
  return DecorationSet.create(doc, decorations);
}

function recompute(state: SearchState, doc: ProseMirrorNode): SearchState {
  const matches = findMatches(doc, state.query, state.caseSensitive);
  const activeIndex = matches.length === 0 ? 0 : Math.min(state.activeIndex, matches.length - 1);
  return { ...state, matches, activeIndex, decorations: buildDecorations(doc, matches, activeIndex) };
}

export const SearchExtension = Extension.create({
  name: "documentSearch",

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchPluginKey,
        state: {
          init: () => ({
            query: "",
            caseSensitive: false,
            matches: [],
            activeIndex: 0,
            decorations: DecorationSet.empty
          }),
          apply(tr, value, _oldState, newState) {
            const meta = tr.getMeta(searchPluginKey) as SearchMeta | undefined;
            let next = value;

            if (meta) {
              next = {
                ...next,
                query: meta.query ?? next.query,
                caseSensitive: meta.caseSensitive ?? next.caseSensitive
              };
              if (typeof meta.setActiveIndex === "number") {
                next = { ...next, activeIndex: meta.setActiveIndex };
              }
              next = recompute(next, newState.doc);
              if (meta.step && next.matches.length > 0) {
                const count = next.matches.length;
                const activeIndex = (next.activeIndex + meta.step + count) % count;
                next = { ...next, activeIndex, decorations: buildDecorations(newState.doc, next.matches, activeIndex) };
              }
              return next;
            }

            if (tr.docChanged && next.query) {
              // Map existing matches forward, then recompute against the new doc
              // so highlights stay accurate as the document (or a replacement)
              // changes.
              return recompute(next, newState.doc);
            }

            return next;
          }
        },
        props: {
          decorations(state) {
            return searchPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
          }
        }
      })
    ];
  }
});

export function getSearchState(state: EditorState): SearchState | undefined {
  return searchPluginKey.getState(state);
}

function setMeta(tr: Transaction, meta: SearchMeta) {
  return tr.setMeta(searchPluginKey, meta);
}

// Imperative helpers (called from the find bar). They dispatch plugin metas and,
// for replace, real document transactions (which flow through collaboration).
export function setSearchQuery(state: EditorState, dispatch: (tr: Transaction) => void, query: string, caseSensitive: boolean) {
  dispatch(setMeta(state.tr, { query, caseSensitive, setActiveIndex: 0 }));
}

export function stepSearch(state: EditorState, dispatch: (tr: Transaction) => void, step: 1 | -1) {
  dispatch(setMeta(state.tr, { step }));
}

export function replaceCurrentMatch(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
  replacement: string
): boolean {
  const search = getSearchState(state);
  if (!search || search.matches.length === 0) return false;
  const match = search.matches[search.activeIndex] ?? search.matches[0];
  const tr = state.tr.insertText(replacement, match.from, match.to);
  dispatch(tr);
  return true;
}

export function replaceAllMatches(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
  replacement: string
): number {
  const search = getSearchState(state);
  if (!search || search.matches.length === 0) return 0;
  const tr = state.tr;
  // Replace from last match to first so earlier positions stay valid.
  for (let i = search.matches.length - 1; i >= 0; i -= 1) {
    const match = search.matches[i];
    tr.insertText(replacement, match.from, match.to);
  }
  dispatch(tr);
  return search.matches.length;
}
