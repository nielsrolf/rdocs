import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeAgentComments, validateAgentComments } from "../lib/ai-edit-submission";

const DOC = "The introduction sets the stage. The methodology is sound. Results are clear.";

test("validateAgentComments accepts a unique anchor with a body", () => {
  assert.equal(
    validateAgentComments([{ findText: "methodology is sound", body: "Cite a source here." }], DOC),
    null
  );
});

test("validateAgentComments rejects a missing anchor", () => {
  const err = validateAgentComments([{ findText: "conclusion", body: "x" }], DOC);
  assert.ok(err && /not found/i.test(err));
});

test("validateAgentComments rejects a non-unique anchor", () => {
  const err = validateAgentComments([{ findText: "The ", body: "x" }], DOC);
  assert.ok(err && /appears|multiple/i.test(err));
});

test("validateAgentComments reports the offending index", () => {
  const err = validateAgentComments(
    [
      { findText: "introduction", body: "ok" },
      { findText: "nope-not-here", body: "x" }
    ],
    DOC
  );
  assert.ok(err && /#2/.test(err));
});

test("validateAgentComments is a no-op for empty/undefined and never throws", () => {
  assert.equal(validateAgentComments(undefined, DOC), null);
  assert.equal(validateAgentComments([], DOC), null);
  assert.doesNotThrow(() => validateAgentComments([{ findText: "", body: "" }], DOC));
});

test("normalizeAgentComments drops entries without findText or body and caps count", () => {
  const normalized = normalizeAgentComments([
    { findText: "ok", body: "comment" },
    { findText: "", body: "x" },
    { findText: "y", body: "  " },
    "garbage"
  ]);
  assert.equal(normalized.length, 1);
  assert.deepEqual(normalized[0], { findText: "ok", body: "comment" });

  const many = Array.from({ length: 200 }, (_, i) => ({ findText: `f${i}`, body: `b${i}` }));
  assert.ok(normalizeAgentComments(many).length <= 50);
});
