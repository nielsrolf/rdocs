import assert from "node:assert/strict";
import test from "node:test";

import { EditorState } from "@tiptap/pm/state";

import { mapRemotePosition, type ReceivedMappingEntry } from "../components/document-workspace/collaboration";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";

// Regression coverage for: "in realtime collab mode, the cursor position and
// selected text were sometimes wrong when people typed in earlier sections."
// The fix is that a remote collaborator's positions must be mapped forward
// through (a) the step mappings we received at/after their version and (b) our
// own unconfirmed local steps. mapRemotePosition is that logic.

const schema = createDocumentEditorSchema();

// "Hello brave world" in one paragraph. Char positions:
//   H1 e2 l3 l4 o5 _6 b7 r8 a9 v10 e11 _12 w13 o14 r15 l16 d17  (end = 18)
// The remote selection covers "brave" = [7, 12). Position 1 is clearly BEFORE
// it and position 13 is clearly AFTER it (no boundary ambiguity).
function baseState() {
  return EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hello brave world" }] }]
    })
  });
}

// Build a received-mapping entry from a transaction that inserts `text` at `pos`.
function receivedInsert(versionBefore: number, pos: number, text: string): ReceivedMappingEntry {
  const tr = baseState().tr.insertText(text, pos);
  return { versionBefore, mapping: tr.mapping };
}

function unconfirmedInsert(pos: number, text: string) {
  const tr = baseState().tr.insertText(text, pos);
  return tr.steps.map((step) => step.getMap());
}

test("a remote selection shifts right when a received edit inserts BEFORE it", () => {
  // Remote selected "brave" [7,12) at version 0; locally we are now at version 1
  // because we received a 3-char insert at position 1 (an earlier section).
  const received = [receivedInsert(0, 1, "XXX")];
  assert.equal(mapRemotePosition(7, 0, -1, 1, received, []), 10);
  assert.equal(mapRemotePosition(12, 0, 1, 1, received, []), 15);
});

test("a remote selection is unchanged when the received edit inserts AFTER it", () => {
  // Insert at position 13 (start of "world"), strictly after the selection.
  const received = [receivedInsert(0, 13, "!!!")];
  assert.equal(mapRemotePosition(7, 0, -1, 1, received, []), 7);
  assert.equal(mapRemotePosition(12, 0, 1, 1, received, []), 12);
});

test("unconfirmed local steps shift a remote selection even at the same version", () => {
  // remoteVersion === localVersion, so received mappings are skipped, but our
  // own pending (not-yet-acked) local insert before the selection must apply.
  const unconfirmed = unconfirmedInsert(1, "ZZ");
  assert.equal(mapRemotePosition(7, 1, -1, 1, [], unconfirmed), 9);
  assert.equal(mapRemotePosition(12, 1, 1, 1, [], unconfirmed), 14);
});

test("received mappings older than the remote version are NOT re-applied", () => {
  // The remote position was captured at version 2, but the only buffered mapping
  // is from version 0->1. Applying it would double-count an edit the remote has
  // already incorporated, mis-placing the cursor. It must be skipped.
  const received = [receivedInsert(0, 1, "XXX")];
  assert.equal(mapRemotePosition(7, 2, -1, 2, received, []), 7);
});

test("received + unconfirmed compose: both an acked and a pending earlier insert shift the selection", () => {
  const received = [receivedInsert(0, 1, "AAAA")]; // +4 before selection, acked
  const unconfirmed = unconfirmedInsert(1, "BB"); // +2 before selection, pending
  // 7 -> +4 (received) -> 11 -> +2 (unconfirmed) -> 13
  assert.equal(mapRemotePosition(7, 0, -1, 1, received, unconfirmed), 13);
});

test("inserting exactly at the selection start respects bias (selection start stays put with bias -1)", () => {
  // Insert at position 7 (the selection's `from`). With bias -1 the inserted
  // text lands to the LEFT of the selection start, so `from` does not move into
  // the inserted text; with bias +1 (used for `to`) a same-point insert would
  // expand. Here we only assert the `from` boundary behavior.
  const received = [receivedInsert(0, 7, "__")];
  assert.equal(mapRemotePosition(7, 0, -1, 1, received, []), 7);
});
