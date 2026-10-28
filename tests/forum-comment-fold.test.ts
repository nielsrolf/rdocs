import assert from "node:assert/strict";
import test from "node:test";

import {
  countComments,
  forumCommentAncestorIds,
  patchComment,
  type ForumCommentView
} from "../components/forum/forum-comments";

// Folding replies hides a subtree; a #comment-<id> permalink (or a click in the
// outline sidebar) must unfold exactly the comments that enclose its target.

const leaf = (id: string, replies: ForumCommentView[] = []): ForumCommentView => ({
  id,
  threadId: "t",
  parentId: null,
  body: id,
  authorName: "x",
  authorId: "u",
  isAi: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  canEdit: false,
  anchorQuote: null,
  replies,
  score: 0,
  ownVote: 0,
  agreement: 0,
  ownAgreement: 0
});

const tree = [leaf("a", [leaf("b", [leaf("c")]), leaf("d")]), leaf("e")];

test("ancestor ids of a nested comment are listed outermost first", () => {
  assert.deepEqual(forumCommentAncestorIds(tree, "c"), ["a", "b"]);
  assert.deepEqual(forumCommentAncestorIds(tree, "d"), ["a"]);
  assert.deepEqual(forumCommentAncestorIds(tree, "a"), []);
  assert.deepEqual(forumCommentAncestorIds(tree, "e"), []);
  assert.deepEqual(forumCommentAncestorIds(tree, "missing"), []);
});

test("countComments counts the whole subtree (fold labels, outline reply counts)", () => {
  assert.equal(countComments(tree), 5);
  assert.equal(countComments(tree[0].replies), 3);
});

test("patchComment updates a nested comment's karma for the outline", () => {
  const next = patchComment(tree, "c", { score: 4, ownVote: 1 });
  assert.equal(next[0].replies[0].replies[0].score, 4);
  assert.equal(next[0].score, 0);
  assert.equal(tree[0].replies[0].replies[0].score, 0);
});
