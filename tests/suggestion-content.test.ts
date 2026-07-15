import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeCommittedContent,
  flattenDocumentTextNodes,
  SUGGESTED_DELETION_MARK,
  SUGGESTED_INSERTION_MARK,
  SUGGESTION_INSERT_RECORDS_ATTR
} from "../lib/suggestion-content";

function ins(text: string) {
  return { type: "text", text, marks: [{ type: SUGGESTED_INSERTION_MARK, attrs: { suggestionId: "i1" } }] };
}
function del(text: string) {
  return { type: "text", text, marks: [{ type: SUGGESTED_DELETION_MARK, attrs: { suggestionId: "d1" } }] };
}
function plain(text: string) {
  return { type: "text", text };
}

const docWith = (...children: unknown[]) => ({
  type: "doc",
  content: [{ type: "paragraph", content: children }]
});

test("reject-all view drops insertions and keeps (un-strikes) deletions", () => {
  const content = docWith(plain("Hello "), ins("brave "), del("cruel "), plain("world"));
  const committed = computeCommittedContent(content) as { content: { content: { text: string }[] }[] };
  // "Hello " + "cruel " + "world" — insertion gone, deletion kept as plain text.
  const para = committed.content[0].content;
  const text = para.map((n) => n.text).join("");
  assert.equal(text, "Hello cruel world");
  // The kept deletion text no longer carries the suggestion mark.
  assert.ok(para.every((n) => !(n as { marks?: unknown[] }).marks));
});

test("accept-all view commits insertions and removes deletions", () => {
  const content = docWith(plain("Hello "), ins("brave "), del("cruel "), plain("world"));
  const accepted = computeCommittedContent(content, { reject: false }) as {
    content: { content: { text: string }[] }[];
  };
  const text = accepted.content[0].content.map((n) => n.text).join("");
  assert.equal(text, "Hello brave world");
});

test("reject-all merges adjacent text nodes so the committed view is canonical", () => {
  // A document that originally said "Hello world" with a suggestion inserted in
  // the middle must reject back to a SINGLE merged text node, identical to the
  // never-suggested document — this is what the collab permission guard compares.
  const suggested = docWith(plain("Hello "), ins("brave "), plain("world"));
  const original = docWith(plain("Hello world"));
  const committed = computeCommittedContent(suggested);
  assert.deepEqual(committed, original);
});

test("atom insert records are dropped on reject, cleared on accept", () => {
  const content = {
    type: "doc",
    content: [
      {
        type: "embeddedWidget",
        attrs: { label: "W", [SUGGESTION_INSERT_RECORDS_ATTR]: [{ suggestionId: "a1", authorId: "u1" }] }
      },
      { type: "paragraph", content: [plain("after")] }
    ]
  };
  const rejected = computeCommittedContent(content) as { content: { type: string }[] };
  assert.equal(rejected.content.length, 1);
  assert.equal(rejected.content[0].type, "paragraph");

  const accepted = computeCommittedContent(content, { reject: false }) as {
    content: Array<{ type: string; attrs?: Record<string, unknown> }>;
  };
  assert.equal(accepted.content.length, 2);
  assert.deepEqual(accepted.content[0].attrs?.[SUGGESTION_INSERT_RECORDS_ATTR], []);
});

test("committed-view guard: adding a suggestion keeps committed view equal; editing committed text changes it", () => {
  // This is exactly the predicate lib/collaboration.ts uses to authorize a
  // comment-access push (suggestionOnly).
  const original = docWith(plain("Hello world"));
  const committed = (content: unknown) => JSON.stringify(computeCommittedContent(content));

  // A push that only inserts a tracked suggestion → committed view unchanged → allowed.
  const withSuggestion = docWith(plain("Hello "), ins("brave "), plain("world"));
  assert.equal(committed(withSuggestion), committed(original));

  // A push that commits new text (no suggestion mark) → committed view changes → rejected.
  const withCommittedEdit = docWith(plain("Hello brave world"));
  assert.notEqual(committed(withCommittedEdit), committed(original));

  // Accepting a suggestion (insertion → committed text) also changes the committed view.
  const accepted = docWith(plain("Hello brave world"));
  assert.notEqual(committed(accepted), committed(withSuggestion));
});

test("adding a comment anchor does NOT change the committed view (annotations are not content)", () => {
  const committed = (content: unknown) => JSON.stringify(computeCommittedContent(content));
  const plainDoc = docWith(plain("Hello world"));
  // Same text, but "world" now carries a commentAnchor mark + the paragraph an
  // aiEditSelectionIds attr — both annotations a comment-access user may add.
  const annotatedDoc = docWith(
    plain("Hello "),
    { type: "text", text: "world", marks: [{ type: "commentAnchor", attrs: { threadId: "t1" } }] }
  );
  assert.equal(committed(annotatedDoc), committed(plainDoc));
});

test("comment anchor on a hardBreak (or other inline node) does NOT change the committed view", () => {
  // Regression: a comment anchored over a range that spans a hardBreak applies the
  // `commentAnchor` mark to the hardBreak node too (addMark marks all inline
  // content, not just text). computeCommittedContent used to strip the mark only
  // from `text` nodes, so the marked hardBreak survived and the committed view
  // differed — tripping the server suggestion-only guard, which the client then
  // mis-escalated into a force-push / merge dialog and the comment was lost.
  const committed = (content: unknown) => JSON.stringify(computeCommittedContent(content));
  const plainDoc = docWith(plain("Hello "), { type: "hardBreak" }, plain("world"));
  const annotatedDoc = docWith(
    { type: "text", text: "Hello ", marks: [{ type: "commentAnchor", attrs: { threadId: "t1" } }] },
    { type: "hardBreak", marks: [{ type: "commentAnchor", attrs: { threadId: "t1" } }] },
    { type: "text", text: "world", marks: [{ type: "commentAnchor", attrs: { threadId: "t1" } }] }
  );
  assert.equal(committed(annotatedDoc), committed(plainDoc));
});

test("flattenDocumentTextNodes concatenates text in document order, no separators", () => {
  const content = {
    type: "doc",
    content: [
      { type: "paragraph", content: [plain("Hello "), { type: "text", text: "world", marks: [{ type: "bold" }] }] },
      { type: "paragraph", content: [plain("Second")] }
    ]
  };
  assert.equal(flattenDocumentTextNodes(content), "Hello worldSecond");
});
