import assert from "node:assert/strict";
import test from "node:test";

import { collab, getVersion, receiveTransaction, sendableSteps } from "@tiptap/pm/collab";
import { EditorState } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";

import {
  buildReceivedMappingEntry,
  mapRemotePosition,
  type ReceivedMappingEntry
} from "../components/document-workspace/collaboration";
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

// Regression coverage for: "their cursor jumps around while I am typing, and
// arrives at the correct position after a second."
//
// Lifecycle of a local edit relative to a remote collaborator's cursor:
//   1. While the local steps are UNCONFIRMED, remote positions are shifted by
//      sendableSteps' maps — correct.
//   2. When the server accepts the push it echoes our own steps back and we
//      confirm them via receiveTransaction. That transaction changes nothing
//      in the local doc, so its `.mapping` is EMPTY. The old code recorded that
//      empty mapping into the received-mapping buffer; the moment the steps
//      left the unconfirmed buffer, every remote position snapped back to its
//      pre-edit spot (the "jump"), staying wrong until the peer re-sent
//      presence at the new version.
// The fix: record the server-canonical mapping built from the steps themselves
// (buildReceivedMappingEntry), which is identical to receiveTr.mapping for
// foreign steps but stays correct for own-step confirmations.

test("remote cursor does not jump when our own typed steps get confirmed", () => {
  // Local editor at version 0 with the collab plugin, remote peer's cursor at
  // position 13 (start of "world"), captured at version 0.
  let state = EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hello brave world" }] }]
    }),
    plugins: [collab({ version: 0, clientID: "me" })]
  });
  const remotePos = 13;

  // Type "abc" at position 1 — three steps, all unconfirmed.
  state = state.apply(state.tr.insertText("a", 1));
  state = state.apply(state.tr.insertText("b", 2));
  state = state.apply(state.tr.insertText("c", 3));

  const sendable = sendableSteps(state);
  assert.ok(sendable && sendable.steps.length === 3);

  // Phase 1: unconfirmed — remote cursor shifts with the pending steps.
  const unconfirmedMaps = sendable.steps.map((step) => step.getMap());
  assert.equal(mapRemotePosition(remotePos, 0, -1, getVersion(state), [], unconfirmedMaps), 16);

  // Phase 2: server accepts the push and echoes our steps back. Confirm them
  // exactly as applyCollaborationPayload does.
  const echoed = sendable.steps.map((step) => Step.fromJSON(schema, step.toJSON()));
  const versionBefore = getVersion(state);
  const receiveTr = receiveTransaction(state, echoed, ["me", "me", "me"], {
    mapSelectionBackward: true
  });
  const entry = buildReceivedMappingEntry(versionBefore, echoed);
  state = state.apply(receiveTr);

  assert.equal(getVersion(state), 3);
  assert.equal(sendableSteps(state), null); // nothing unconfirmed anymore

  // The remote cursor (still reported at version 0) must STAY at 16 — with the
  // old empty-mapping recording it snapped back to 13 until fresh presence
  // arrived, which is the visible jump.
  assert.equal(mapRemotePosition(remotePos, 0, -1, getVersion(state), [entry], []), 16);

  // Cursor BEFORE the edit stays put through confirmation.
  assert.equal(mapRemotePosition(1, 0, -1, getVersion(state), [entry], []), 1);

  // A selection COVERING the edit point expands consistently: from (before the
  // insert, bias -1) stays, to (after it) shifts.
  assert.equal(mapRemotePosition(1, 0, -1, getVersion(state), [entry], []), 1);
  assert.equal(mapRemotePosition(6, 0, 1, getVersion(state), [entry], []), 9);
});

test("an entry straddling the remote version applies only the steps the remote has not seen", () => {
  // One confirmed batch covers versions 0..2 (two 1-char inserts at pos 1).
  // A remote position captured at version 1 must be mapped through only the
  // SECOND step, not the whole batch (and not skipped entirely).
  const tr1 = baseState().tr.insertText("X", 1);
  const state1 = baseState().apply(tr1);
  const tr2 = state1.tr.insertText("Y", 1);
  const entry = buildReceivedMappingEntry(0, [...tr1.steps, ...tr2.steps]);

  // Captured at version 0: both steps apply (+2).
  assert.equal(mapRemotePosition(7, 0, -1, 2, [entry], []), 9);
  // Captured at version 1: only the second step applies (+1).
  assert.equal(mapRemotePosition(7, 1, -1, 2, [entry], []), 8);
  // Captured at version 2: nothing applies.
  assert.equal(mapRemotePosition(7, 2, -1, 2, [entry], []), 7);
});
