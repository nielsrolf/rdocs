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

// Regression for the residual "remote cursor jumps forward while the other
// person is typing" artifact: their presence packet (cursor already past the
// just-typed char) reaches us before their insert step does, so our block
// still lacks that char. `before` then contains a char we don't have, the full
// context can't match, and the cursor used to render one position AHEAD of the
// not-yet-arrived text. When the remote is ahead of us we instead pin the
// cursor to the stable text AFTER it (the current insertion boundary).
test("pins the remote cursor to the insertion boundary when the remote is ahead (mid-block)", () => {
  // Our block lacks the just-typed "X". Remote cursor sits after "HelloX".
  const block = "Hello world";
  const ctx = { before: "HelloX", after: " world" };
  const mapped = BLOCK_START + 6; // where the remote's head maps to (ahead of our text)
  // Without the ahead-aware fix this returns the mapped (ahead) position — the jump.
  assert.equal(reanchorWithinBlock(block, BLOCK_START, mapped, ctx, true), BLOCK_START + 5);
  // Backwards-compatible: with remoteAhead omitted/false it keeps old behavior.
  assert.equal(reanchorWithinBlock(block, BLOCK_START, mapped, ctx), mapped);
});

test("clamps the remote cursor to block end when typing at the end while ahead", () => {
  const block = "Hello"; // our doc lacks the just-typed "X"
  const ctx = { before: "HelloX", after: "" };
  const mapped = BLOCK_START + 6; // one past our block's end
  assert.equal(reanchorWithinBlock(block, BLOCK_START, mapped, ctx, true), BLOCK_START + 5);
});

test("ahead-aware mode still prefers an exact full-context match when present", () => {
  // If the surrounding text DOES exist (edit was elsewhere), behave normally.
  const pos = BLOCK_START + 19;
  const ctx = { before: "fox", after: " ju" };
  assert.equal(reanchorWithinBlock(TEXT, BLOCK_START, pos - 3, ctx, true), pos);
});
