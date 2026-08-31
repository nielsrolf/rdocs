import assert from "node:assert/strict";
import test from "node:test";

import {
  footnoteNumberByThreadId,
  isFootnoteThread
} from "../components/document-workspace/comment-footnotes";

test("Footnote is a case-insensitive semantic thread tag", () => {
  assert.equal(isFootnoteThread({ tags: ["Footnote"] }), true);
  assert.equal(isFootnoteThread({ tags: ["footnote"] }), true);
  assert.equal(isFootnoteThread({ tags: ["Todo"] }), false);
});

test("footnotes are numbered by anchor position, ignoring ordinary comments", () => {
  const numbers = footnoteNumberByThreadId([
    { id: "late", position: 40, tags: ["Footnote"] },
    { id: "comment", position: 5, tags: ["Todo"] },
    { id: "early", position: 12, tags: ["footnote"] }
  ]);

  assert.equal(numbers.get("early"), 1);
  assert.equal(numbers.get("late"), 2);
  assert.equal(numbers.has("comment"), false);
});
