import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// Forum comments render markdown → HTML (MarkdownBody). The HTML already
// carries block spacing via <p>/<ul> margins, and markdown-it separates blocks
// with "\n". A `white-space: pre-wrap` on that container turns every one of
// those source newlines into a visible blank line (2026-09-02 screenshot:
// huge gaps between paragraphs and list items). Guard the rendered containers.
function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected a CSS rule for ${selector}`);
  return match[1];
}

test("rendered-markdown comment bodies do not use white-space: pre-wrap", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  for (const selector of [".forum-comment-body", ".quicktake-body"]) {
    assert.doesNotMatch(cssRule(css, selector), /white-space:\s*pre/, `${selector} must not pre-wrap rendered HTML`);
  }
});
