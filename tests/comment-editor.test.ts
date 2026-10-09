import assert from "node:assert/strict";
import test from "node:test";

import { generateJSON } from "@tiptap/html";

import {
  commentDocToMarkdown,
  commentEditorExtensions,
  commentMarkdownToHtml,
  looksLikeMarkdown
} from "../lib/comment-editor";
import { extractMentionedUserIds } from "../lib/mentions";

// Load a stored comment into the editor and save it straight back.
function roundTrip(markdown: string) {
  const json = generateJSON(commentMarkdownToHtml(markdown), commentEditorExtensions());
  return commentDocToMarkdown(json);
}

const STABLE = [
  "Plain sentence. E.g. this, with dots and (parens) and #hash - dash!",
  "**bold**, *italic*, ~~gone~~ and `npm test`",
  "See [the spec](https://example.com/a_b) and https://example.com/raw_url",
  "- What should be our process?\n  - How autonomous?\n  - What questions?\n- Second",
  "1. one\n2. two\n   - nested",
  "## Heading\n\nBody text",
  "> quoted\n> lines",
  "```\nconst x = a * b_c;\n```",
  "Math $\\mu_0 = a*b$ inline and $$E = mc^2$$",
  "line one\nline two",
  "@ada_l@example.com and @Member Mary please look",
  "| a | b |\n| --- | --- |\n| 1 | 2 |",
  "![diagram](https://example.com/d.png)"
];

for (const markdown of STABLE) {
  test(`comment markdown survives an edit round-trip: ${JSON.stringify(markdown.slice(0, 40))}`, () => {
    assert.equal(roundTrip(markdown), markdown);
  });
}

test("literal markdown characters typed in the editor are escaped, so they stay literal", () => {
  const json = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "2*3*4 and [x] and _private_" }] }]
  };
  assert.equal(commentDocToMarkdown(json), "2\\*3\\*4 and \\[x\\] and \\_private\\_");
});

test("mentions stay detectable in what the editor stores", () => {
  const stored = roundTrip("Ping @ada_l@example.com");
  assert.deepEqual(
    extractMentionedUserIds(stored, [{ id: "u1", name: "Ada", email: "ada_l@example.com" }]),
    ["u1"]
  );
});

test("pasted base64 images are not accepted into a comment", () => {
  const json = generateJSON(
    '<p>before</p><img src="data:image/png;base64,iVBORw0KGgo="><p>after</p>',
    commentEditorExtensions()
  );
  const markdown = commentDocToMarkdown(json);
  assert.ok(!markdown.includes("base64"), markdown);
});

test("looksLikeMarkdown spots markdown pasted as plain text, not prose", () => {
  assert.equal(looksLikeMarkdown("- a\n- b"), true);
  assert.equal(looksLikeMarkdown("Use **this** one"), true);
  assert.equal(looksLikeMarkdown("## Title"), true);
  assert.equal(looksLikeMarkdown("Just a normal sentence - with a dash."), false);
  assert.equal(looksLikeMarkdown("2 * 3 = 6"), false);
});

// What the r-docs editor puts on the clipboard (text/html) when a nested
// bullet list is copied — the user-reported case that used to paste as
// blank-line-separated paragraphs. The comment editor parses it against its
// own schema (as ProseMirror does on paste) and stores a nested list.
test("a nested list copied from a doc is stored as a markdown list", () => {
  const html =
    '<ul data-pm-slice="3 3 []"><li><p>What should be our process to pick research projects?</p>' +
    "<ul><li><p>How autonomous vs team aligned should this happen?</p></li>" +
    "<li><p>What questions should we be asking at which stages of a project? E.g. at the start of an exploration?</p></li></ul></li></ul>";
  assert.equal(
    commentDocToMarkdown(generateJSON(html, commentEditorExtensions())),
    [
      "- What should be our process to pick research projects?",
      "  - How autonomous vs team aligned should this happen?",
      "  - What questions should we be asking at which stages of a project? E.g. at the start of an exploration?"
    ].join("\n")
  );
});
