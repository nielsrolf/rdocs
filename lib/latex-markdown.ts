import katex from "katex";
import type MarkdownIt from "markdown-it";

// Adds $...$ / $$...$$ math support to a markdown-it instance, mirroring the
// editor's latex semantics (components/document-workspace/latex.ts): non-empty
// content between matching delimiters; backslash-escaped $ is left alone
// (markdown-it's escape rule consumes it before this rule runs).
//
// output: "katex" renders math to KaTeX HTML — for display-only surfaces
// (comments, run timeline). "source" re-emits the literal $...$ text — REQUIRED
// for any HTML that gets parsed back into document nodes: the editor schema has
// no math node (it renders equations as decorations over literal $...$ text),
// so KaTeX HTML would be flattened into tripled plain text (mathml text + tex
// annotation + rendered glyphs) and the equation would never render again.
export function addLatexSupport(md: MarkdownIt, options?: { output?: "katex" | "source" }) {
  const output = options?.output ?? "katex";
  md.inline.ruler.before("emphasis", "latex", (state, silent) => {
    const src = state.src;
    if (src.charCodeAt(state.pos) !== 0x24 /* $ */) return false;

    const isDisplay = src.startsWith("$$", state.pos);
    const delimiter = isDisplay ? "$$" : "$";
    const contentStart = state.pos + delimiter.length;
    const end = src.indexOf(delimiter, contentStart);
    if (end === -1 || end === contentStart) return false;

    const latex = src.slice(contentStart, end).trim();
    if (!latex) return false;

    if (!silent) {
      const token = state.push("latex", "span", 0);
      token.content = latex;
      token.meta = { displayMode: isDisplay };
    }
    state.pos = end + delimiter.length;
    return true;
  });

  md.renderer.rules.latex = (tokens, idx) => {
    const meta = (tokens[idx].meta ?? {}) as { displayMode?: boolean };
    if (output === "source") {
      const delimiter = meta.displayMode ? "$$" : "$";
      return md.utils.escapeHtml(`${delimiter}${tokens[idx].content}${delimiter}`);
    }
    return katex.renderToString(tokens[idx].content, {
      displayMode: Boolean(meta.displayMode),
      strict: "ignore",
      throwOnError: false,
      trust: false
    });
  };
}
