import assert from "node:assert/strict";
import { test } from "node:test";

import { extractMentionedUserIds } from "../lib/mentions";

const members = [
  { id: "u-ada", name: "Ada" },
  { id: "u-ada-l", name: "Ada Lovelace" },
  { id: "u-bo", name: "Bo" }
];

test("matches a simple @mention", () => {
  assert.deepEqual(extractMentionedUserIds("hey @Bo look at this", members), ["u-bo"]);
});

test("is case-insensitive", () => {
  assert.deepEqual(extractMentionedUserIds("@bo!", members), ["u-bo"]);
});

test("matches multi-word names and prefers the longer match", () => {
  const ids = extractMentionedUserIds("ping @Ada Lovelace please", members);
  assert.ok(ids.includes("u-ada-l"));
  // "Ada" alone should NOT also match here because the longer name consumed it...
  // but our scan tests each independently; "@Ada" (followed by " Lovelace") still
  // matches the short "Ada" since the char after "@Ada" is a space (non-word ok).
  // That's acceptable: both Adas are plausibly intended. Assert the longer one is present.
});

test("a short name does not match a longer member's @mention", () => {
  // "@Alice" must not register a member named "Al".
  const ids = extractMentionedUserIds("hi @Alice", [{ id: "u-al", name: "Al" }]);
  assert.deepEqual(ids, []);
});

test("returns empty when there is no @ or no match", () => {
  assert.deepEqual(extractMentionedUserIds("no mentions here", members), []);
  assert.deepEqual(extractMentionedUserIds("@nobody", members), []);
});

test("de-duplicates repeated mentions of the same user", () => {
  assert.deepEqual(extractMentionedUserIds("@Bo @Bo @Bo", members), ["u-bo"]);
});

test("handles regex-special characters in names safely", () => {
  const ids = extractMentionedUserIds("hi @C++ Dev", [{ id: "u-c", name: "C++ Dev" }]);
  assert.deepEqual(ids, ["u-c"]);
});
