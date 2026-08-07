import assert from "node:assert/strict";
import test from "node:test";

import { classifyRunArtifacts, hasRenderableRunArtifacts } from "../components/document-workspace/run-result";

test("comment-run artifacts distinguish the final reply from standalone comments and suggestions", () => {
  const artifacts = classifyRunArtifacts({
    triggerType: "COMMENT_THREAD",
    triggerId: "trigger-thread",
    replacementText: null,
    comments: [
      { id: "reply", threadId: "trigger-thread", anchorText: "todo", body: "The actual final reply." },
      { id: "review", threadId: "review-thread", anchorText: "Methods", body: "Intermediate review note." }
    ],
    suggestions: [
      { findText: "old sentence", replacementText: "new sentence", reason: "More precise." }
    ]
  });

  assert.deepEqual(artifacts.finalReplies.map((comment) => comment.body), ["The actual final reply."]);
  assert.deepEqual(artifacts.standaloneComments.map((comment) => comment.body), ["Intermediate review note."]);
  assert.equal(artifacts.suggestions.length, 1);
  assert.equal(hasRenderableRunArtifacts(artifacts), true);
});

test("selection-edit artifacts expose the final edit even without a conversational reply", () => {
  const artifacts = classifyRunArtifacts({
    triggerType: "SELECTION_EDIT",
    triggerId: null,
    replacementText: "## Revised section\n\nFinal prose.",
    comments: [],
    suggestions: []
  });
  assert.equal(artifacts.finalEdit, "## Revised section\n\nFinal prose.");
  assert.equal(hasRenderableRunArtifacts(artifacts), true);
});
