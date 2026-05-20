import assert from "node:assert/strict";
import test from "node:test";

import { buildAiRunSelectionTriggerId, parseAiRunSelectionId } from "../components/document-workspace/utils";

test("selection trigger id encodes the selection id", () => {
  const triggerId = buildAiRunSelectionTriggerId("edit-123");

  assert.equal(triggerId, "selection:edit-123");
  assert.equal(parseAiRunSelectionId(triggerId), "edit-123");
});

test("parseAiRunSelectionId extracts selection id from legacy {id}:{from}:{to} form", () => {
  assert.equal(parseAiRunSelectionId("selection:edit-123:12:34"), "edit-123");
});

test("parseAiRunSelectionId ignores legacy offsets-only form (no stable id)", () => {
  assert.equal(parseAiRunSelectionId("selection:12:34"), null);
});

test("parseAiRunSelectionId handles missing or non-selection triggers", () => {
  assert.equal(parseAiRunSelectionId(null), null);
  assert.equal(parseAiRunSelectionId(""), null);
  assert.equal(parseAiRunSelectionId("thread:abc"), null);
});
