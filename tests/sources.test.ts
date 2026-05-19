import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSourceLinks, parseSourceLinks, serializeSourceLinks } from "../lib/sources";

test("source link normalization trims, deduplicates, and keeps only http URLs", () => {
  assert.deepEqual(normalizeSourceLinks([" https://example.com/a ", "ftp://example.com/a", "", "https://example.com/a"]), [
    "https://example.com/a"
  ]);
});

test("source link serialization and parsing tolerate empty or malformed values", () => {
  assert.equal(serializeSourceLinks(["notaurl", "   "]), null);
  assert.deepEqual(parseSourceLinks(null), []);
  assert.deepEqual(parseSourceLinks("not json"), []);
  assert.deepEqual(parseSourceLinks(JSON.stringify(["https://example.com", 42, "mailto:test@example.com"])), [
    "https://example.com"
  ]);
});
