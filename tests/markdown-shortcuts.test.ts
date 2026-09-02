import assert from "node:assert/strict";
import test from "node:test";

import {
  isUrlLike,
  markdownKeyEdit,
  markdownPasteEdit,
  wrapSelection
} from "../lib/markdown-shortcuts";

// Keyboard-driven markdown editing for the plain <textarea> composers (forum
// comments, quicktakes, studio comment rail): wrap a selection with a marker,
// Cmd/Ctrl+K links, and "paste a URL over a selection" → markdown link.

const sel = (text: string, from: string) => {
  const start = text.indexOf(from);
  return { text, start, end: start + from.length };
};

test("wrapSelection wraps and re-selects the inner text; wrapping again toggles it off", () => {
  const once = wrapSelection(sel("say hello world", "hello"), "**");
  assert.equal(once.text, "say **hello** world");
  assert.equal(once.text.slice(once.start, once.end), "hello");
  const twice = wrapSelection(once, "**");
  assert.equal(twice.text, "say hello world");
  assert.equal(twice.text.slice(twice.start, twice.end), "hello");
});

test("typing $ with a selection turns it into inline latex, without a selection it types a plain $", () => {
  const edit = markdownKeyEdit(sel("if u_a > u_b then", "u_a > u_b"), { key: "$" });
  assert.ok(edit);
  assert.equal(edit.text, "if $u_a > u_b$ then");
  assert.equal(markdownKeyEdit({ text: "costs 5", start: 7, end: 7 }, { key: "$" }), null);
});

test("backtick, * and _ wrap a selection too", () => {
  assert.equal(markdownKeyEdit(sel("run npm test now", "npm test"), { key: "`" })?.text, "run `npm test` now");
  assert.equal(markdownKeyEdit(sel("a b c", "b"), { key: "*" })?.text, "a *b* c");
  assert.equal(markdownKeyEdit(sel("a b c", "b"), { key: "_" })?.text, "a _b_ c");
});

test("Cmd+B / Cmd+I toggle bold and italic", () => {
  const bold = markdownKeyEdit(sel("a b c", "b"), { key: "b", mod: true });
  assert.equal(bold?.text, "a **b** c");
  assert.equal(markdownKeyEdit(sel("a b c", "b"), { key: "i", mod: true })?.text, "a _b_ c");
  // No selection: insert an empty pair and put the caret inside.
  const empty = markdownKeyEdit({ text: "a ", start: 2, end: 2 }, { key: "b", mod: true });
  assert.equal(empty?.text, "a ****");
  assert.equal(empty?.start, 4);
  assert.equal(empty?.end, 4);
});

test("Cmd+K on selected text makes a link and selects the url placeholder", () => {
  const edit = markdownKeyEdit(sel("see the docs here", "the docs"), { key: "k", mod: true });
  assert.ok(edit);
  assert.equal(edit.text, "see [the docs](url) here");
  assert.equal(edit.text.slice(edit.start, edit.end), "url");
});

test("Cmd+K uses a URL from the clipboard when one is supplied", () => {
  const edit = markdownKeyEdit(sel("see the docs here", "the docs"), {
    key: "k",
    mod: true,
    clipboardText: " https://example.com/x "
  });
  assert.equal(edit?.text, "see [the docs](https://example.com/x) here");
  // Caret lands after the link.
  assert.equal(edit?.start, edit?.end);
  assert.equal(edit?.end, "see [the docs](https://example.com/x)".length);
});

test("Cmd+K on a selected URL asks for the link text instead", () => {
  const edit = markdownKeyEdit(sel("go https://a.io now", "https://a.io"), { key: "k", mod: true });
  assert.equal(edit?.text, "go [text](https://a.io) now");
  assert.equal(edit?.text.slice(edit.start, edit.end), "text");
});

test("Cmd+K with no selection inserts a link skeleton with the text placeholder selected", () => {
  const edit = markdownKeyEdit({ text: "a ", start: 2, end: 2 }, { key: "k", mod: true });
  assert.equal(edit?.text, "a [text](url)");
  assert.equal(edit?.text.slice(edit.start, edit.end), "text");
});

test("pasting a URL over selected text produces a markdown link; other pastes are left to the browser", () => {
  const edit = markdownPasteEdit(sel("read the paper today", "the paper"), "https://arxiv.org/abs/1");
  assert.equal(edit?.text, "read [the paper](https://arxiv.org/abs/1) today");
  assert.equal(markdownPasteEdit(sel("read the paper today", "the paper"), "some words"), null);
  assert.equal(markdownPasteEdit({ text: "x", start: 1, end: 1 }, "https://a.io"), null);
});

test("isUrlLike", () => {
  assert.ok(isUrlLike("https://example.com/a?b=c"));
  assert.ok(isUrlLike("http://localhost:3000"));
  assert.ok(!isUrlLike("not a url"));
  assert.ok(!isUrlLike("https://has space.com"));
});

test("plain keys and unrelated modifier combos are ignored", () => {
  assert.equal(markdownKeyEdit(sel("a b c", "b"), { key: "x" }), null);
  assert.equal(markdownKeyEdit(sel("a b c", "b"), { key: "$", mod: true }), null);
  assert.equal(markdownKeyEdit(sel("a b c", "b"), { key: "z", mod: true }), null);
});
