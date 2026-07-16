import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import katex from "katex";

type LatexMatch = {
  from: number;
  to: number;
  sourceFrom: number;
  sourceTo: number;
  latex: string;
  displayMode: boolean;
};

function findLatexMatches(text: string, basePosition: number) {
  const matches: LatexMatch[] = [];
  let index = 0;

  while (index < text.length) {
    const displayStart = text.indexOf("$$", index);
    const inlineStart = text.indexOf("$", index);
    if (displayStart === -1 && inlineStart === -1) {
      break;
    }

    const isDisplay = displayStart !== -1 && (inlineStart === -1 || displayStart <= inlineStart);
    const start = isDisplay ? displayStart : inlineStart;
    if (start > 0 && text[start - 1] === "\\") {
      index = start + 1;
      continue;
    }

    const delimiter = isDisplay ? "$$" : "$";
    const contentStart = start + delimiter.length;
    const end = text.indexOf(delimiter, contentStart);
    if (end === -1 || end === contentStart) {
      index = contentStart;
      continue;
    }

    const latex = text.slice(contentStart, end).trim();
    if (latex) {
      matches.push({
        from: basePosition + start,
        to: basePosition + end + delimiter.length,
        sourceFrom: basePosition + contentStart,
        sourceTo: basePosition + end,
        latex,
        displayMode: isDisplay
      });
    }

    index = end + delimiter.length;
  }

  return matches;
}

// One placeholder char per inline leaf (image, widget, …) keeps string offsets
// aligned with doc positions; matches containing it are rejected below so an
// equation never "spans" an atom.
const INLINE_LEAF_PLACEHOLDER = "￼";

export function findLatexMatchesInDoc(doc: ProseMirrorNode) {
  const matches: LatexMatch[] = [];
  doc.descendants((node, position) => {
    if (!node.isTextblock) {
      return true;
    }
    // Scan the whole textblock, not individual text nodes: marks added over a
    // selection (commentAnchor, mention, …) split text nodes, which must not
    // hide an equation whose $ delimiters end up in different nodes.
    const text = node.textBetween(0, node.content.size, undefined, INLINE_LEAF_PLACEHOLDER);
    for (const match of findLatexMatches(text, position + 1)) {
      if (!match.latex.includes(INLINE_LEAF_PLACEHOLDER)) {
        matches.push(match);
      }
    }
    return false;
  });
  return matches;
}

export function createLatexRenderExtension() {
  return Extension.create({
    name: "latexRender",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("latexRender"),
          props: {
            handleDOMEvents: {
              mousedown(view, event) {
                const target = event.target;
                if (!(target instanceof Element)) {
                  return false;
                }

                const rendered = target.closest<HTMLElement>(".latex-render");
                if (!rendered?.dataset.sourceFrom || !rendered.dataset.sourceTo) {
                  return false;
                }

                const sourceFrom = Number(rendered.dataset.sourceFrom);
                const sourceTo = Number(rendered.dataset.sourceTo);
                if (!Number.isFinite(sourceFrom) || !Number.isFinite(sourceTo)) {
                  return false;
                }

                event.preventDefault();
                view.focus();
                view.dispatch(
                  view.state.tr
                    .setSelection(TextSelection.create(view.state.doc, sourceFrom, sourceTo))
                    .scrollIntoView()
                );
                return true;
              }
            },
            decorations(state) {
              const decorations: Decoration[] = [];
              const { from: selectionFrom, to: selectionTo } = state.selection;

              findLatexMatchesInDoc(state.doc).forEach((match) => {
                  const isActive = selectionFrom <= match.to && selectionTo >= match.from;
                  decorations.push(
                    Decoration.inline(match.from, match.to, {
                      class: isActive ? "latex-source latex-source-active" : "latex-source latex-source-hidden"
                    })
                  );
                  if (!isActive) {
                    decorations.push(
                      Decoration.widget(
                        match.from,
                        () => {
                          const rendered = document.createElement(match.displayMode ? "div" : "span");
                          rendered.className = match.displayMode
                            ? "latex-render latex-render-display"
                            : "latex-render";
                          rendered.dataset.sourceFrom = String(match.sourceFrom);
                          rendered.dataset.sourceTo = String(match.sourceTo);
                          rendered.innerHTML = katex.renderToString(match.latex, {
                            displayMode: match.displayMode,
                            strict: "ignore",
                            throwOnError: false,
                            trust: false
                          });
                          rendered.title = match.displayMode ? `$$${match.latex}$$` : `$${match.latex}$`;
                          return rendered;
                        },
                        {
                          key: `latex:${match.from}:${match.to}:${match.displayMode ? "display" : "inline"}:${match.latex}`,
                          side: -1
                        }
                      )
                    );
                  }
              });

              return DecorationSet.create(state.doc, decorations);
            }
          }
        })
      ];
    }
  });
}
