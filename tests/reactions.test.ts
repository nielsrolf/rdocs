import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateReactions,
  isReactionEmoji,
  REACTION_EMOJIS,
  toggleReactionLocal
} from "../lib/reactions";

test("isReactionEmoji only accepts palette members", () => {
  assert.equal(isReactionEmoji("👍"), true);
  assert.equal(isReactionEmoji("🚀"), true);
  assert.equal(isReactionEmoji("🦄"), false);
  assert.equal(isReactionEmoji("not-an-emoji"), false);
  assert.equal(isReactionEmoji(null), false);
});

test("aggregateReactions counts per emoji and flags the current user", () => {
  const rows = [
    { emoji: "👍", userId: "u1", user: { name: "Ann" } },
    { emoji: "👍", userId: "u2", user: { name: "Bo" } },
    { emoji: "🎉", userId: "u2", user: { name: "Bo" } }
  ];
  const result = aggregateReactions(rows, "u2");
  assert.equal(result.length, 2);

  const thumbs = result.find((r) => r.emoji === "👍")!;
  assert.equal(thumbs.count, 2);
  assert.equal(thumbs.reactedByMe, true);
  assert.deepEqual(thumbs.users, ["Ann", "Bo"]);

  const party = result.find((r) => r.emoji === "🎉")!;
  assert.equal(party.count, 1);
  assert.equal(party.reactedByMe, true);
});

test("reactedByMe is false when the user has not reacted (or is anonymous)", () => {
  const rows = [{ emoji: "👍", userId: "u1", user: { name: "Ann" } }];
  assert.equal(aggregateReactions(rows, "u9")[0].reactedByMe, false);
  assert.equal(aggregateReactions(rows, null)[0].reactedByMe, false);
});

test("aggregateReactions orders entries by the fixed palette", () => {
  // Provide in scrambled order; expect palette order (👍 before 🎉 before 👀).
  const rows = [
    { emoji: "👀", userId: "u1" },
    { emoji: "🎉", userId: "u1" },
    { emoji: "👍", userId: "u1" }
  ];
  const order = aggregateReactions(rows, null).map((r) => r.emoji);
  const expected = REACTION_EMOJIS.filter((e) => order.includes(e));
  assert.deepEqual(order, expected);
});

test("empty input yields no summaries", () => {
  assert.deepEqual(aggregateReactions([], "u1"), []);
});

test("toggleReactionLocal adds a brand-new reaction", () => {
  const next = toggleReactionLocal([], "👍", "Ann");
  assert.deepEqual(next, [{ emoji: "👍", count: 1, reactedByMe: true, users: ["Ann"] }]);
});

test("toggleReactionLocal joins an existing reaction the user hasn't made", () => {
  const start = [{ emoji: "👍", count: 1, reactedByMe: false, users: ["Bo"] }];
  const next = toggleReactionLocal(start, "👍", "Ann");
  assert.equal(next[0].count, 2);
  assert.equal(next[0].reactedByMe, true);
  assert.deepEqual(next[0].users, ["Bo", "Ann"]);
});

test("toggleReactionLocal removes the user's own reaction, dropping empty entries", () => {
  const start = [{ emoji: "👍", count: 1, reactedByMe: true, users: ["Ann"] }];
  assert.deepEqual(toggleReactionLocal(start, "👍", "Ann"), []);
});

test("toggleReactionLocal is its own inverse (rollback)", () => {
  const start = [
    { emoji: "👍", count: 2, reactedByMe: false, users: ["Bo", "Cy"] },
    { emoji: "🎉", count: 1, reactedByMe: true, users: ["Ann"] }
  ];
  const once = toggleReactionLocal(start, "👍", "Ann");
  const twice = toggleReactionLocal(once, "👍", "Ann");
  assert.deepEqual(twice, start);
});
