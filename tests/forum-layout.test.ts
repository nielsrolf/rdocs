import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_FORUM_LAYOUT, normalizeForumLayout, resolveForumLayout } from "../lib/forum-layout";

// The forum frontpage layout toggle ("unified" one feed vs "split" sections):
// the browser cookie is the freshest signal, the account setting follows it,
// garbage falls back to the default.

test("forum layout resolves cookie first, then stored preference, then default", () => {
  assert.equal(DEFAULT_FORUM_LAYOUT, "unified");
  assert.equal(resolveForumLayout("split", "unified"), "split");
  assert.equal(resolveForumLayout(undefined, "split"), "split");
  assert.equal(resolveForumLayout("bogus", "split"), "split");
  assert.equal(resolveForumLayout(null, null), "unified");
  assert.equal(resolveForumLayout("nonsense", "garbage"), "unified");
  assert.equal(normalizeForumLayout("split"), "split");
  assert.equal(normalizeForumLayout(42), "unified");
});
