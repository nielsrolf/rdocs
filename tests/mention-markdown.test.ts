import assert from "node:assert/strict";
import { test } from "node:test";

import { renderCommentHtml } from "../lib/mention-markdown";

const members = [
  { id: "u-ada", name: "Ada", email: "ada@example.com" },
  { id: "u-ada-l", name: "Ada Lovelace", email: "lovelace@example.com" },
  { id: "u-bo", name: "Bo", email: "bo@example.com" }
];

test("wraps a recognized @name in a mention-other span", () => {
  const html = renderCommentHtml("hey @Bo look", { members, currentUserId: "u-ada" });
  assert.match(html, /<span class="mention mention-other" data-mention-user-id="u-bo">@Bo<\/span>/);
});

test("marks a self-mention with mention-self", () => {
  const html = renderCommentHtml("ping @Ada please", { members, currentUserId: "u-ada" });
  assert.match(html, /<span class="mention mention-self" data-mention-user-id="u-ada">@Ada<\/span>/);
});

test("recognizes an @email mention", () => {
  const html = renderCommentHtml("@bo@example.com review?", { members, currentUserId: null });
  assert.match(html, /data-mention-user-id="u-bo">@bo@example\.com<\/span>/);
});

test("prefers the longest matching handle (Ada Lovelace over Ada)", () => {
  const html = renderCommentHtml("cc @Ada Lovelace", { members, currentUserId: null });
  assert.match(html, /data-mention-user-id="u-ada-l">@Ada Lovelace<\/span>/);
});

test("leaves an unrecognized @handle as plain text", () => {
  const html = renderCommentHtml("hi @nobody", { members, currentUserId: null });
  assert.doesNotMatch(html, /class="mention/);
  assert.match(html, /@nobody/);
});

test("does not treat a plain email in a word as a mention", () => {
  const html = renderCommentHtml("write to foo@bar.com", { members, currentUserId: null });
  assert.doesNotMatch(html, /class="mention/);
});

test("still renders ordinary markdown around mentions", () => {
  const html = renderCommentHtml("**bold** and @Bo", { members, currentUserId: null });
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /class="mention mention-other"/);
});

test("renders nothing special when there are no members", () => {
  const html = renderCommentHtml("hey @Bo", { members: [], currentUserId: null });
  assert.doesNotMatch(html, /class="mention/);
});
