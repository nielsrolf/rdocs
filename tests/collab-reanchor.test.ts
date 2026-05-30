import assert from "node:assert/strict";
import { test } from "node:test";

import { reanchorWithinBlock } from "../components/document-workspace/collaboration";

// blockStart is the ProseMirror position of the first char of the block; within
// a text block, position = blockStart + textIndex.
const BLOCK_START = 1;
const TEXT = "The quick brown fox jumps over the lazy dog";

test("no-op when context is missing or empty", () => {
  assert.equal(reanchorWithinBlock(TEXT, BLOCK_START, 10, undefined), 10);
  assert.equal(reanchorWithinBlock(TEXT, BLOCK_START, 10, { before: "", after: "" }), 10);
});

test("keeps the mapped position when the surrounding text already matches", () => {
  // Cursor between "quick" and " brown": text index 9 -> pos 10.
  const pos = BLOCK_START + 9;
  const ctx = { before: "ick", after: " br" };
  assert.equal(reanchorWithinBlock(TEXT, BLOCK_START, pos, ctx), pos);
});

test("re-anchors a drifted position back onto its context text", () => {
  // The true cursor sits after "fox" (text index 19 -> pos 20), with context
  // "fox"/" ju". Simulate OT drift: the mapped position is 3 too low.
  const truePos = BLOCK_START + 19;
  const ctx = { before: "fox", after: " ju" };
  const drifted = truePos - 3;
  assert.equal(reanchorWithinBlock(TEXT, BLOCK_START, drifted, ctx), truePos);
});

test("chooses the occurrence nearest the mapped position when text repeats", () => {
  const text = "abc XX abc XX abc"; // "abc" appears at indices 0, 7, 14
  const ctx = { before: "ab", after: "c" }; // split after "ab" -> index+2
  // Mapped near the middle occurrence (index 7 -> split pos blockStart+9).
  const near = BLOCK_START + 9;
  assert.equal(reanchorWithinBlock(text, BLOCK_START, near + 1, ctx), BLOCK_START + 9);
  // Mapped near the last occurrence (index 14 -> split pos blockStart+16).
  assert.equal(reanchorWithinBlock(text, BLOCK_START, BLOCK_START + 15, ctx), BLOCK_START + 16);
});

test("falls back to the mapped position when context is absent from the block", () => {
  const ctx = { before: "zzz", after: "yyy" };
  assert.equal(reanchorWithinBlock(TEXT, BLOCK_START, 12, ctx), 12);
});
