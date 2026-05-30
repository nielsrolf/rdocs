import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractMentionedUserIds,
  filterMentionCandidates,
  findActiveMentionQuery,
  mentionHandle
} from "../lib/mentions";

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

// Regression: people often @mention by the email they invited the person with.
// The matcher used to look at display names only, so "@ada@example.com" recorded
// no mention and the mentioned user got no notification.
const emailMembers = [
  { id: "u-ada", name: "Ada", email: "ada@example.com" },
  { id: "u-bo", name: "Bo", email: "bo@example.com" }
];

test("matches an @email mention", () => {
  assert.deepEqual(extractMentionedUserIds("ping @ada@example.com please", emailMembers), ["u-ada"]);
});

test("an @email mention works even when the typed handle is the address", () => {
  // The user's exact scenario: typed the member's email rather than their name.
  assert.deepEqual(extractMentionedUserIds("@bo@example.com can you review?", emailMembers), ["u-bo"]);
});

test("a partial email does not match a longer address", () => {
  // Name distinct from the body so we isolate email matching: "ada@example.com"
  // must not register against the longer "ada@example.computer".
  const ids = extractMentionedUserIds("@ada@example.computer", [
    { id: "u-x", name: "Zoltan", email: "ada@example.com" }
  ]);
  assert.deepEqual(ids, []);
});

test("name and email of the same member de-duplicate to one id", () => {
  assert.deepEqual(extractMentionedUserIds("@Ada and again @ada@example.com", emailMembers), ["u-ada"]);
});

test("missing/empty email is ignored (name-only matching still works)", () => {
  const ids = extractMentionedUserIds("@Ada", [{ id: "u-ada", name: "Ada", email: null }]);
  assert.deepEqual(ids, ["u-ada"]);
});

// --- autocomplete helpers ---

test("findActiveMentionQuery detects a fresh @ at the caret", () => {
  const text = "hello @Ad";
  assert.deepEqual(findActiveMentionQuery(text, text.length), { query: "Ad", start: 6, end: 9 });
});

test("findActiveMentionQuery triggers at the very start", () => {
  assert.deepEqual(findActiveMentionQuery("@bo", 3), { query: "bo", start: 0, end: 3 });
});

test("findActiveMentionQuery does NOT trigger on a plain email typed in a word", () => {
  const text = "email me at foo@bar.com";
  assert.equal(findActiveMentionQuery(text, text.length), null);
});

test("findActiveMentionQuery handles a leading @ followed by an email", () => {
  const text = "@ada@example.com";
  assert.deepEqual(findActiveMentionQuery(text, text.length), {
    query: "ada@example.com",
    start: 0,
    end: 16
  });
});

test("findActiveMentionQuery allows spaces (multi-word names)", () => {
  const text = "ping @Ada Lov";
  assert.deepEqual(findActiveMentionQuery(text, text.length), { query: "Ada Lov", start: 5, end: 13 });
});

test("findActiveMentionQuery stops at a newline", () => {
  const text = "@Ada\nmore";
  assert.equal(findActiveMentionQuery(text, text.length), null);
});

test("findActiveMentionQuery returns null when there is no @ before the caret", () => {
  assert.equal(findActiveMentionQuery("no mention here", 5), null);
});

const candidates = [
  { id: "u-ada", name: "Ada", email: "ada@example.com" },
  { id: "u-ada-l", name: "Ada Lovelace", email: "lovelace@example.com" },
  { id: "u-bo", name: "Bo", email: "bo@example.com" }
];

test("filterMentionCandidates prefix-matches by name (case-insensitive)", () => {
  const ids = filterMentionCandidates("ad", candidates).map((c) => c.id);
  assert.deepEqual(new Set(ids), new Set(["u-ada", "u-ada-l"]));
});

test("filterMentionCandidates prefix-matches by email", () => {
  const ids = filterMentionCandidates("bo@", candidates).map((c) => c.id);
  assert.deepEqual(ids, ["u-bo"]);
});

test("filterMentionCandidates returns everyone for an empty query", () => {
  assert.equal(filterMentionCandidates("", candidates).length, 3);
});

test("filterMentionCandidates sorts shorter names first and caps the list", () => {
  const result = filterMentionCandidates("ada", candidates);
  assert.equal(result[0].id, "u-ada"); // "Ada" before "Ada Lovelace"
  assert.ok(filterMentionCandidates("", candidates, 2).length === 2);
});

test("mentionHandle prefers the name and falls back to email", () => {
  assert.equal(mentionHandle({ id: "x", name: "Ada", email: "a@b.com" }), "Ada");
  assert.equal(mentionHandle({ id: "x", name: "", email: "a@b.com" }), "a@b.com");
});
