import assert from "node:assert/strict";
import test from "node:test";

import { addCommentAnchorToContent, differsOnlyByCommentAnchors } from "../lib/comment-anchors";
import { stripCommentAnchorMarks } from "../lib/content";

test("adds comment anchors on the server without changing underlying document text", () => {
  const content = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Hello world" }]
      }
    ]
  };

  const anchored = addCommentAnchorToContent(content, 1, 6, "thread-1") as typeof content;

  assert.deepEqual(stripCommentAnchorMarks(anchored), content);
  assert.equal(differsOnlyByCommentAnchors(content, anchored), true);

  const paragraph = anchored.content[0] as {
    content?: Array<{ text?: string; marks?: Array<{ type: string; attrs?: unknown }> }>;
  };
  assert.deepEqual(paragraph.content?.map((node) => node.text), ["Hello", " world"]);
  assert.equal(paragraph.content?.[0]?.marks?.[0]?.type, "commentAnchor");
  assert.equal((paragraph.content?.[0]?.marks?.[0]?.attrs as { threadId: string }).threadId, "thread-1");
  assert.equal(paragraph.content?.[1]?.marks, undefined);
});

test("detects real document content changes in fallback comment payloads", () => {
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
