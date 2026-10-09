import assert from "node:assert/strict";
import test from "node:test";

import { richClipboardToMarkdown } from "../lib/clipboard-markdown";

// What the r-docs editor (ProseMirror) puts on the clipboard as text/html when
// a nested bullet list is copied. Its text/plain flavour separates every block
// with blank lines, which is what forum comment boxes used to paste.
const PM_NESTED_LIST_HTML =
  '<ul data-pm-slice="3 3 []"><li><p>What should be our process to pick research projects?</p>' +
  "<ul><li><p>How autonomous vs team aligned should this happen?</p></li>" +
  "<li><p>What questions should we be asking at which stages of a project? E.g. at the start of an exploration, after spending one week on the project, after spending one month on a project?</p></li></ul></li></ul>";

test("a nested list copied from a doc pastes as a markdown list", () => {
  assert.equal(
    richClipboardToMarkdown(PM_NESTED_LIST_HTML),
    [
      "- What should be our process to pick research projects?",
      "  - How autonomous vs team aligned should this happen?",
      "  - What questions should we be asking at which stages of a project? E.g. at the start of an exploration, after spending one week on the project, after spending one month on a project?"
    ].join("\n")
  );
});

test("inline formatting, headings and links survive the paste", () => {
  const html =
    '<meta charset="utf-8"><h2 data-pm-slice="1 1 []">Plan</h2><p>Read <strong>this</strong> <em>first</em>: <a href="https://example.com">spec</a> and <code>npm test</code></p>';
  assert.equal(
    richClipboardToMarkdown(html),
    "## Plan\n\nRead **this** *first*: [spec](https://example.com) and `npm test`"
  );
});

test("plain-looking HTML (code editors, plain spans) falls back to the plain-text paste", () => {
  assert.equal(
    richClipboardToMarkdown('<div style="white-space: pre;"><span>  const x = 1;</span></div>'),
    null
  );
  assert.equal(richClipboardToMarkdown(""), null);
});

test("pasted data-URL images are dropped instead of inlining base64 into a comment", () => {
  const html =
    '<p data-pm-slice="0 0 []">Before</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="shot"><ul><li><p>after</p></li></ul>';
  const markdown = richClipboardToMarkdown(html) ?? "";
  assert.ok(!markdown.includes("base64"), markdown);
  assert.match(markdown, /Before/);
  assert.match(markdown, /- after/);
});
