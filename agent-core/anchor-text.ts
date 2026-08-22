// Tolerant anchor matching for agent-proposed findText anchors (suggestions and
// comments). Pure string logic with zero imports so it can run anywhere the
// validator runs: in-process, inside the agent container (agent-core is the only
// code shipped into the images), and in the browser (re-exported through
// lib/suggestion-content for the client resolver).
//
// WHY tolerance: the agent sees the document in renditions that are close to —
// but not byte-identical with — the anchor basis it is validated against
// (lib/suggestion-content.flattenDocumentAnchorText, text nodes joined with
// newlines at block boundaries). The prompt's plain-text view separates blocks
// with blank lines, and MCP read_document returns markdown ([text](url) links,
// escaped punctuation, heading/list markers). A model that copies "verbatim"
// from either view used to produce anchors that could never validate
// (2026-08-19 incident: 4/4 submission attempts burned on doomed anchors). The
// tiers below accept those faithful copies while still requiring the match to
// be UNIQUE at the tier that produced it.
//
// The server validator and the client resolver both call findAnchorMatch, so
// what passes validation resolves to exactly the same range in the editor.

export type AnchorMatchResult = {
  /** Number of matches found at the first tier that matched at all. */
  count: number;
  /** Raw offset of the first match's start in the haystack (-1 when count is 0). */
  start: number;
  /** Raw offset just past the first match's end in the haystack (-1 when count is 0). */
  end: number;
};

const NO_MATCH: AnchorMatchResult = { count: 0, start: -1, end: -1 };

/**
 * Locates `needle` in `haystack` (the flattened anchor text) using tiered,
 * progressively more tolerant matching:
 *   1. exact substring;
 *   2. newline-normalized — any whitespace run containing a newline (on either
 *      side) compares equal to a single newline, and boundary whitespace on the
 *      needle is ignored;
 *   3. markdown-stripped needle — [text](url) links, ![alt](src) images,
 *      backslash escapes, heading/list/quote markers, emphasis and inline code
 *      are removed from the NEEDLE, then tiers 1–2 run again.
 * Returns the match count of the first tier that finds anything, plus the raw
 * haystack offsets of the first match. Callers enforce uniqueness (count === 1).
 */
export function findAnchorMatch(haystack: string, needle: string): AnchorMatchResult {
  if (!needle || !haystack) return NO_MATCH;

  const exact = exactMatch(haystack, needle);
  if (exact.count > 0) return exact;

  const normalized = normalizedMatch(haystack, needle);
  if (normalized.count > 0) return normalized;

  const stripped = stripMarkdownSyntax(needle);
  if (stripped && stripped !== needle) {
    const strippedExact = exactMatch(haystack, stripped);
    if (strippedExact.count > 0) return strippedExact;
    return normalizedMatch(haystack, stripped);
  }
  return NO_MATCH;
}

function exactMatch(haystack: string, needle: string): AnchorMatchResult {
  let count = 0;
  let first = -1;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    if (first === -1) first = index;
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  if (count === 0) return NO_MATCH;
  return { count, start: first, end: first + needle.length };
}

// Collapses every whitespace run that contains at least one newline into a
// single "\n", keeping a map from each normalized character back to its raw
// offset (the first character of a collapsed run).
function normalizeNewlines(input: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      let j = i;
      let hasNewline = false;
      while (j < input.length) {
        const c = input[j];
        if (c !== " " && c !== "\t" && c !== "\r" && c !== "\n") break;
        if (c === "\n") hasNewline = true;
        j += 1;
      }
      if (hasNewline) {
        text += "\n";
        map.push(i);
        i = j;
        continue;
      }
      // A run of plain spaces/tabs is kept verbatim.
      while (i < j) {
        text += input[i];
        map.push(i);
        i += 1;
      }
      continue;
    }
    text += ch;
    map.push(i);
    i += 1;
  }
  return { text, map };
}

function normalizedMatch(haystack: string, needle: string): AnchorMatchResult {
  const h = normalizeNewlines(haystack);
  // Boundary whitespace on the needle (e.g. a trailing newline copied from a
  // block boundary) carries no anchoring information — drop it.
  const n = normalizeNewlines(needle).text.replace(/^[\s\n]+|[\s\n]+$/g, "");
  if (!n) return NO_MATCH;

  let count = 0;
  let first = -1;
  let index = h.text.indexOf(n);
  while (index !== -1) {
    if (first === -1) first = index;
    count += 1;
    index = h.text.indexOf(n, index + n.length);
  }
  if (count === 0) return NO_MATCH;
  const start = h.map[first];
  const end = h.map[first + n.length - 1] + 1;
  return { count, start, end };
}

/**
 * Removes markdown syntax the agent may have copied from a markdown rendition
 * of the document (MCP read_document): links/images keep their visible text,
 * backslash escapes are unescaped, line-leading block markers (headings,
 * blockquotes, list bullets/numbers) are dropped, emphasis and inline code
 * markers are unwrapped. Exported for tests.
 */
export function stripMarkdownSyntax(input: string): string {
  let out = input;
  // Images first (so the link pattern below doesn't half-match "![").
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links: keep the visible text.
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Backslash escapes of markdown punctuation.
  out = out.replace(/\\([\\`*_{}[\]()#+\-.!>~|"'])/g, "$1");
  // Line-leading block markers (possibly stacked, e.g. "> - item").
  out = out.replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d{1,3}[.)][ \t]+)+/gm, "");
  // Bold / bold-italic wrappers.
  out = out.replace(/(\*\*\*|___|\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  // Inline code.
  out = out.replace(/`([^`\n]+)`/g, "$1");
  return out;
}
