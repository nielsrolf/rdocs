import assert from "node:assert/strict";
import { test } from "node:test";

import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import {
  collectSuggestionRanges,
  groupSuggestions,
  suggestionAuthors,
  SUGGESTION_TEXT_CLIP
} from "../components/document-workspace/suggestions";

// "Who suggested what": the review list is built from the suggestion marks in
// the document — author, kind and the suggested text itself.

const schema = createDocumentEditorSchema();

const mark = (type: string, id: string, authorId: string, authorLabel: string) => ({
  type,
  attrs: { suggestionId: id, authorId, authorLabel, createdAt: "2026-11-16T10:00:00.000Z" }
});
const ins = (id: string, authorId: string, label: string) => mark("suggestedInsertion", id, authorId, label);
const del = (id: string, authorId: string, label: string) => mark("suggestedDeletion", id, authorId, label);

test("suggestions are listed with their author, kind and text, in document order", () => {
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "The " },
          { type: "text", text: "quick", marks: [del("s1", "u1", "Alice")] },
          { type: "text", text: "slow", marks: [ins("s1", "u1", "Alice")] },
          { type: "text", text: " fox " },
          { type: "text", text: "really ", marks: [ins("s2", "u2", "Bo")] },
          // One insertion split by formatting stays one suggestion.
          { type: "text", text: "jumps", marks: [{ type: "bold" }, ins("s2", "u2", "Bo")] }
        ]
      },
      { type: "paragraph", content: [{ type: "text", text: "Gone.", marks: [del("s3", "u1", "Alice")] }] },
      { type: "paragraph", content: [{ type: "text", text: "x".repeat(400), marks: [ins("s4", "ai", "claude-sonnet")] }] }
    ]
  });

  const overview = groupSuggestions(collectSuggestionRanges(doc));
  assert.deepEqual(
    overview.map((s) => [s.id, s.label, s.author.authorLabel, s.deletedText, s.insertedText.slice(0, 20)]),
    [
      ["s1", "Replace", "Alice", "quick", "slow"],
      ["s2", "Insert", "Bo", "", "really jumps"],
      ["s3", "Delete", "Alice", "Gone.", ""],
      ["s4", "Insert", "claude-sonnet", "", "x".repeat(20)]
    ]
  );
  assert.equal(overview[0].createdAt, "2026-11-16T10:00:00.000Z");
  // The range covers both halves of a replacement, so "jump" selects all of it.
  assert.equal(doc.textBetween(overview[0].from, overview[0].to), "quickslow");
  // Long suggestions are clipped, not dumped into the list.
  assert.equal(overview[3].insertedText.length, SUGGESTION_TEXT_CLIP + 1);
  assert.ok(overview[3].insertedText.endsWith("…"));

  assert.deepEqual(
    suggestionAuthors(overview).map((a) => [a.label, a.count]),
    [["Alice", 2], ["Bo", 1], ["claude-sonnet", 1]]
  );
});

test("a suggestion without a recorded author is listed as Unknown, apart from named authors", () => {
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "a", marks: [{ type: "suggestedInsertion", attrs: { suggestionId: "s1" } }] },
          { type: "text", text: " " },
          { type: "text", text: "b", marks: [ins("s2", "u1", "Alice")] }
        ]
      }
    ]
  });
  assert.deepEqual(
    suggestionAuthors(groupSuggestions(collectSuggestionRanges(doc))).map((a) => [a.label, a.count]),
    [["Alice", 1], ["Unknown", 1]]
  );
});
