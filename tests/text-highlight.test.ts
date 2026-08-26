import assert from "node:assert/strict";
import test from "node:test";

import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import { HIGHLIGHT_COLORS, isHighlightColor } from "../lib/text-highlight";

test("document schema preserves each supported text highlight color", () => {
  const schema = createDocumentEditorSchema();
  for (const color of HIGHLIGHT_COLORS) {
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: color, marks: [{ type: "textHighlight", attrs: { color } }] }]
      }]
    });
    assert.equal(doc.firstChild?.firstChild?.marks[0]?.attrs.color, color);
  }
  assert.equal(isHighlightColor("blue"), false);
});
