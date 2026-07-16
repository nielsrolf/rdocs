import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMENT_CARD_GAP,
  COMMENT_RAIL_TOP_MARGIN,
  layoutCommentRail
} from "../components/document-workspace/comment-rail-layout";

test("cards sit at their anchor when there is room", () => {
  const { offsets } = layoutCommentRail(
    [
      { id: "a", top: 100 },
      { id: "b", top: 600 }
    ],
    null
  );
  assert.equal(offsets.a, 100);
  assert.equal(offsets.b, 600);
});

test("anchors above the margin clamp to the margin", () => {
  const { offsets } = layoutCommentRail([{ id: "a", top: -40 }], null);
  assert.equal(offsets.a, COMMENT_RAIL_TOP_MARGIN);
});

test("a tall card pushes the next card below its real height", () => {
  // Regression: the rail used to assume every card is ~152px tall. A card
  // with long text or several replies is much taller, so the next card was
  // placed on top of it ("comments appear at the wrong height").
  const { offsets } = layoutCommentRail(
    [
      { id: "tall", top: 100 },
      { id: "next", top: 120 }
    ],
    null,
    { tall: 420, next: 130 }
  );
  assert.equal(offsets.tall, 100);
  assert.ok(
    offsets.next >= 100 + 420 + COMMENT_CARD_GAP,
    `next card overlaps the tall one: top=${offsets.next}, needs >= ${100 + 420 + COMMENT_CARD_GAP}`
  );
});

test("rail bottom accounts for the last card's measured height", () => {
  const { bottom } = layoutCommentRail([{ id: "a", top: 50 }], null, { a: 500 });
  assert.equal(bottom, 50 + 500 + COMMENT_CARD_GAP);
});

test("cards keep document order even when anchors are equal after clamping", () => {
  const { offsets } = layoutCommentRail(
    [
      { id: "a", top: 0 },
      { id: "b", top: 0 }
    ],
    null,
    { a: 100, b: 100 }
  );
  const tops = [offsets.a, offsets.b].sort((x, y) => x - y);
  assert.ok(tops[1] >= tops[0] + 100 + COMMENT_CARD_GAP);
});
