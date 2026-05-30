import assert from "node:assert/strict";
import { test } from "node:test";

import { EditorState } from "@tiptap/pm/state";

import { buildMentionInsertTransaction } from "../components/document-workspace/mention";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";

const schema = createDocumentEditorSchema();

function mentionRunsIn(doc: ReturnType<typeof schema.nodeFromJSON>) {
  const runs: Array<{ text: string; userId: unknown }> = [];
  doc.descendants((node) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "mention");
    if (mark) runs.push({ text: node.text ?? "", userId: mark.attrs.userId });
  });
  return runs;
}

test("buildMentionInsertTransaction replaces the @query with a marked mention + space", () => {
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "hello @ad" }] }]
  });
  const state = EditorState.create({ doc });
  // "@ad" occupies doc positions 7..10 ("hello " = positions 1..6, "@ad" = 7..9, end 10).
  const tr = buildMentionInsertTransaction(state, { from: 7, to: 10 }, { userId: "u-ada", label: "Ada" });
  assert.ok(tr);

  const runs = mentionRunsIn(tr!.doc);
  assert.deepEqual(runs, [{ text: "@Ada", userId: "u-ada" }]);

  // Full paragraph text now reads "hello @Ada " with a trailing (unmarked) space.
  assert.equal(tr!.doc.textContent, "hello @Ada ");

  // The trailing space carries no mention mark.
  let spaceMarked = false;
  tr!.doc.descendants((node) => {
    if (node.isText && node.text === " " && node.marks.some((m) => m.type.name === "mention")) {
      spaceMarked = true;
    }
  });
  assert.equal(spaceMarked, false);
});

test("the server schema round-trips a document containing a mention mark", () => {
  const json = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "cc " },
          {
            type: "text",
            text: "@Ada",
            marks: [{ type: "mention", attrs: { userId: "u-ada", label: "Ada" } }]
          }
        ]
      }
    ]
  };
  // Would throw "Unknown mark type: mention" if the server schema lacked it.
  const doc = schema.nodeFromJSON(json);
  assert.deepEqual(mentionRunsIn(doc), [{ text: "@Ada", userId: "u-ada" }]);
  // And it survives a serialize → parse round-trip.
  const round = schema.nodeFromJSON(doc.toJSON());
  assert.deepEqual(mentionRunsIn(round), [{ text: "@Ada", userId: "u-ada" }]);
});
