// Repairs SVG markup that an agent corrupted by over-escaping `!`.
//
// When the research agent generates an SVG via a shell/Python one-liner, it tends
// to write comment markers as `<\!-- ... -->` — the `\!` is a reflex from bash
// history-expansion escaping. bash heredocs and Python string literals both keep
// the backslash verbatim (Python even emits a SyntaxWarning for the invalid escape),
// so the committed file contains `<\!--`. That sequence is not well-formed XML, and
// browsers asked to render the file as image/svg+xml abort parsing — the document
// shows only the <img> alt text instead of the plot.
//
// `<\` can never legitimately open markup in XML/SVG, so stripping the stray
// backslash that immediately follows a `<` is a safe, targeted repair. A backslash
// anywhere else (e.g. inside text content) is left untouched.
export function repairSvgMarkup(input: string): string {
  return input.replace(/<\\(?=[!?/a-zA-Z])/g, "<");
}
