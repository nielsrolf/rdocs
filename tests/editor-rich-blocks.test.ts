import assert from "node:assert/strict";
import test from "node:test";

import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import { getDocumentMarkdown, getDocumentPlainText } from "../lib/content";
import { shouldHighlightCommentThread } from "../components/document-workspace/comment-anchors";

test("pasted images support a persisted caption", () => {
  const schema = createDocumentEditorSchema();
  const image = schema.nodes.image.create({
    src: "data:image/png;base64,abc",
    alt: "Chart",
    caption: "Accuracy by model"
  });

  assert.equal(image.attrs.caption, "Accuracy by model");
  assert.equal(
    getDocumentMarkdown({ type: "doc", content: [image.toJSON()] }),
    '![Chart](data:image/png;base64,abc "Accuracy by model")'
  );
});

test("toggle blocks persist a summary and nested rich content", () => {
  const schema = createDocumentEditorSchema();
  const toggle = schema.nodes.toggleBlock.create(
    { summary: "Implementation details" },
    [schema.nodes.paragraph.create(null, schema.text("Hidden explanation"))]
  );
  const doc = schema.nodes.doc.create(null, [toggle]).toJSON();

  assert.equal(toggle.attrs.summary, "Implementation details");
  assert.match(getDocumentPlainText(doc), /Implementation details/);
  assert.match(getDocumentPlainText(doc), /Hidden explanation/);
  assert.match(getDocumentMarkdown(doc), /Implementation details/);
});

test("resolved comments no longer highlight their document anchor", () => {
  assert.equal(shouldHighlightCommentThread({ id: "open", status: "OPEN" }), true);
  assert.equal(shouldHighlightCommentThread({ id: "done", status: "RESOLVED" }), false);
});
