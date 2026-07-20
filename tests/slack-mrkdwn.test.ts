import assert from "node:assert/strict";
import test from "node:test";

import { markdownToMrkdwn } from "../lib/slack/mrkdwn";

test("bold, italic, strikethrough, links", () => {
  assert.equal(markdownToMrkdwn("**bold** and *italic* and ~~gone~~"), "*bold* and _italic_ and ~gone~");
  assert.equal(markdownToMrkdwn("__bold__ too"), "*bold* too");
  assert.equal(markdownToMrkdwn("see [the docs](https://example.com/x)"), "see <https://example.com/x|the docs>");
  assert.equal(markdownToMrkdwn("![plot](https://example.com/p.png)"), "<https://example.com/p.png|plot>");
});

test("headings become bold lines; rules become dividers", () => {
  assert.equal(markdownToMrkdwn("## Results\ntext"), "*Results*\ntext");
  assert.equal(markdownToMrkdwn("a\n---\nb"), "a\n──────────\nb");
});

test("code fences and inline code survive verbatim", () => {
  const fence = "```python\nx = a * b # **not bold**\n```";
  assert.equal(markdownToMrkdwn(fence), fence);
  assert.equal(markdownToMrkdwn("run `foo **bar**` now"), "run `foo **bar**` now");
});

test("star bullets normalize to dashes without becoming italic", () => {
  assert.equal(markdownToMrkdwn("* one\n* two **strong**"), "- one\n- two *strong*");
});

test("tables become aligned code blocks", () => {
  const table = "| model | score |\n| --- | --- |\n| gpt | 1.0 |\n| claude | 2.0 |";
  const result = markdownToMrkdwn(table);
  assert.match(result, /^```\n/);
  assert.match(result, /model {3}score/);
  assert.match(result, /claude {2}2\.0/);
  assert.match(result, /\n```$/);
});

test("bold inside links and multiline prose", () => {
  assert.equal(
    markdownToMrkdwn("The **key** finding:\n\n1. improved *a lot*\n2. see [ref](https://r.io)"),
    "The *key* finding:\n\n1. improved _a lot_\n2. see <https://r.io|ref>"
  );
});
