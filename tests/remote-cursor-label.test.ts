import assert from "node:assert/strict";
import test from "node:test";

import { labelCoversCaret } from "../components/document-workspace/collaboration";

// The peer's name label is drawn ~1.55rem ABOVE their caret and extends to the
// right, so with our caret on the previous line it used to sit on top of it.
const peerLabel = { left: 98, right: 190, top: 76, bottom: 94 };

test("a peer's name label that sits on our caret is detected", () => {
  // Our caret on the line above the peer, a few characters to the right.
  assert.equal(labelCoversCaret(peerLabel, { left: 140, right: 142, top: 74, bottom: 94 }), true);
});

test("a label merely grazing the caret still yields", () => {
  assert.equal(labelCoversCaret(peerLabel, { left: 191, right: 193, top: 74, bottom: 94 }), true);
});

test("labels away from our caret stay visible", () => {
  // Same line as the peer, below the label.
  assert.equal(labelCoversCaret(peerLabel, { left: 140, right: 142, top: 100, bottom: 120 }), false);
  // Line above, but left of the label.
  assert.equal(labelCoversCaret(peerLabel, { left: 40, right: 42, top: 74, bottom: 94 }), false);
});
