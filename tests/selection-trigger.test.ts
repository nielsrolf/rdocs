import assert from "node:assert/strict";
import test from "node:test";

import { buildAiRunSelectionTriggerId, parseAiRunSelectionRange } from "../components/document-workspace/utils";

test("selection trigger ids preserve backwards-compatible offsets", () => {
  assert.deepEqual(parseAiRunSelectionRange("selection:12:34"), {
    id: null,
    from: 12,
    to: 34
  });
});

test("selection trigger ids can carry a stable marker id", () => {
  const triggerId = buildAiRunSelectionTriggerId("edit-123", 12, 34);

  assert.equal(triggerId, "selection:edit-123:12:34");
  assert.deepEqual(parseAiRunSelectionRange(triggerId), {
    id: "edit-123",
    from: 12,
    to: 34
  });
});
