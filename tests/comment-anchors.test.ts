import assert from "node:assert/strict";
import test from "node:test";

import { differsOnlyByCommentAnchors } from "../lib/comment-anchors";

test("detects real document content changes", () => {
  const current = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }]
  };
  const changed = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Changed world" }] }]
  };

  assert.equal(differsOnlyByCommentAnchors(current, changed), false);
});

test("ignores only-commentAnchor-mark differences", () => {
  const plain = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Hello world" }]
      }
    ]
  };
  const anchored = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Hello",
            marks: [{ type: "commentAnchor", attrs: { threadId: "thread-1" } }]
          },
          { type: "text", text: " world" }
        ]
      }
    ]
  };

  assert.equal(differsOnlyByCommentAnchors(plain, anchored), true);
});
