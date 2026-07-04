import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeSuggestions, validateSuggestions } from "../lib/ai-edit-submission";

const DOC = "The quick brown fox jumps over the lazy dog. Foxes are clever.";

test("validateSuggestions accepts a unique, changed anchor", () => {
  assert.equal(
    validateSuggestions([{ findText: "lazy dog", replacementText: "sleepy dog" }], DOC),
    null
  );
});

test("validateSuggestions allows an empty replacement (suggested deletion)", () => {
  assert.equal(validateSuggestions([{ findText: "lazy ", replacementText: "" }], DOC), null);
});

test("validateSuggestions rejects an anchor not present in the document", () => {
  const err = validateSuggestions([{ findText: "elephant", replacementText: "x" }], DOC);
  assert.ok(err && /not found/i.test(err));
});

test("validateSuggestions rejects a non-unique anchor", () => {
  // "ox" appears in both "fox" and "Foxes".
  const err = validateSuggestions([{ findText: "ox", replacementText: "ax" }], DOC);
  assert.ok(err && /multiple|appears/i.test(err));
});

test("validateSuggestions rejects a no-op", () => {
  const err = validateSuggestions([{ findText: "lazy dog", replacementText: "lazy dog" }], DOC);
  assert.ok(err && /identical/i.test(err));
});

test("validateSuggestions reports the index of the offending suggestion", () => {
  const err = validateSuggestions(
    [
      { findText: "quick", replacementText: "swift" },
      { findText: "nope", replacementText: "x" }
    ],
    DOC
  );
  assert.ok(err && /#2/.test(err));
});

test("validateSuggestions is a no-op for empty/undefined and never throws", () => {
  assert.equal(validateSuggestions(undefined, DOC), null);
  assert.equal(validateSuggestions([], DOC), null);
  assert.doesNotThrow(() => validateSuggestions([{ findText: "", replacementText: "x" }], DOC));
});

test("normalizeSuggestions drops malformed entries and caps lengths", () => {
  const normalized = normalizeSuggestions([
    { findText: "ok", replacementText: "new", reason: "because" },
    { findText: "", replacementText: "x" }, // empty findText dropped
    { findText: "missing replacement" }, // no replacementText dropped
    "garbage",
    null
  ]);
  assert.equal(normalized.length, 1);
  assert.deepEqual(normalized[0], { findText: "ok", replacementText: "new", reason: "because" });
});

test("normalizeSuggestions caps the number of suggestions", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ findText: `f${i}`, replacementText: `r${i}` }));
  assert.ok(normalizeSuggestions(many).length <= 50);
});
