import assert from "node:assert/strict";
import test from "node:test";

import { collab, getVersion, receiveTransaction, sendableSteps } from "@tiptap/pm/collab";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";

import {
  buildPresenceSelection,
  buildReceivedMappingEntry,
  mapRemoteSelection,
  pickRenderablePresence,
  type RemotePresenceView,
  type ReceivedMappingEntry
} from "../components/document-workspace/collaboration";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";

// User report (2026-11-07): "when the other person types, their cursor jumps
// around a bit — the offset of the cursor is applied before their document
// diff", and "the text I selected in one tab is sometimes displayed wrong on
// the other tab and stays wrong".
//
// Cause: presence carried the sender's LOCAL positions (which already include
// their unconfirmed, not-yet-pushed steps) labelled with their CONFIRMED
// version. The receiver then maps those positions through the sender's own
// steps once they arrive — counting the sender's edit twice.

const schema = createDocumentEditorSchema();

function editorState(text: string, clientID: string) {
  return EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }]
    }),
    plugins: [collab({ version: 0, clientID })]
  });
}

function typeAt(state: EditorState, pos: number, text: string) {
  let next = state;
  for (let i = 0; i < text.length; i += 1) {
    // Typing: insert at the caret and leave the caret after the new char.
    const tr = next.tr.insertText(text[i], pos + i);
    tr.setSelection(TextSelection.create(tr.doc, pos + i + 1));
    next = next.apply(tr);
  }
  return next;
}

// Apply `steps` from `clientId` on `state` the way applyCollaborationPayload does.
function receive(state: EditorState, steps: Step[], clientId: string, buffer: ReceivedMappingEntry[]) {
  const echoed = steps.map((step) => Step.fromJSON(schema, step.toJSON()));
  buffer.push(buildReceivedMappingEntry(getVersion(state), echoed, echoed.map(() => clientId)));
  return state.apply(receiveTransaction(state, echoed, echoed.map(() => clientId), { mapSelectionBackward: true }));
}

function rendered(receiver: EditorState, presence: ReturnType<typeof buildPresenceSelection>, buffer: ReceivedMappingEntry[]) {
  const unconfirmed = sendableSteps(receiver)?.steps.map((step) => step.getMap()) ?? [];
  return mapRemoteSelection(presence, getVersion(receiver), buffer, unconfirmed, "sender");
}

// "alpha beta": alpha = 1..6, so the caret after "alpha" is position 6.
test("a typing collaborator's cursor sits right after their text once it arrives", () => {
  let sender = editorState("alpha beta", "sender");
  let receiver = editorState("alpha beta", "receiver");
  const buffer: ReceivedMappingEntry[] = [];

  // Sender types "XYZ" after "alpha"; the caret ends at 9. Presence goes out
  // BEFORE their push is confirmed (120 ms presence vs push round-trip).
  sender = typeAt(sender, 6, "XYZ");
  assert.equal(sender.selection.head, 9);
  const presence = buildPresenceSelection(sender);

  // Before the steps arrive, the receiver doesn't have "XYZ": the cursor must
  // sit where the text WILL appear — right after "alpha" — not 3 chars ahead.
  assert.equal(rendered(receiver, presence, buffer).head, 6, "cursor drawn ahead of text we don't have yet");

  // Now the steps arrive (pushed + broadcast). The cursor must be after "XYZ".
  const sendable = sendableSteps(sender);
  assert.ok(sendable);
  receiver = receive(receiver, sendable.steps as Step[], "sender", buffer);
  assert.equal(receiver.doc.textContent, "alphaXYZ beta");
  assert.equal(rendered(receiver, presence, buffer).head, 9, "cursor not right after the just-typed text");
});

test("a collaborator's selection stays on the selected text after their own edit elsewhere arrives", () => {
  let sender = editorState("one two three", "sender");
  let receiver = editorState("one two three", "receiver");
  const buffer: ReceivedMappingEntry[] = [];

  // Sender inserts "NEW " at the start (unconfirmed), then selects "three".
  sender = typeAt(sender, 1, "NEW ");
  const threeFrom = sender.doc.textContent.indexOf("three") + 1;
  sender = sender.apply(
    sender.tr.setSelection(TextSelection.create(sender.doc, threeFrom, threeFrom + "three".length))
  );
  const presence = buildPresenceSelection(sender);

  const sendable = sendableSteps(sender);
  assert.ok(sendable);
  receiver = receive(receiver, sendable.steps as Step[], "sender", buffer);
  const { from, to } = rendered(receiver, presence, buffer);
  const size = receiver.doc.content.size;
  assert.equal(
    receiver.doc.textBetween(Math.min(from, size), Math.min(to, size)),
    "three",
    `selection drawn over the wrong text (from ${from}, to ${to}, doc size ${size})`
  );
});

test("presence that arrives before the steps it refers to is not drawn yet", () => {
  // Sender typed "XYZ" and their push was already accepted (version 3) when
  // their presence goes out; the receiver hasn't applied those steps yet.
  const view = (selection: RemotePresenceView["selection"]): RemotePresenceView => ({
    clientId: "sender",
    userId: null,
    userName: "Sender",
    color: "#123456",
    selection,
    typing: true,
    lastSeen: 0
  });
  const before = view({ anchor: 6, head: 6, from: 6, to: 6, version: 0 });
  const ahead = view({ anchor: 9, head: 9, from: 9, to: 9, version: 3 });

  // Receiver still at version 0: keep drawing the last mappable position.
  assert.equal(pickRenderablePresence(ahead, before, 0)?.selection?.head, 6);
  // Nothing mappable yet: draw nothing rather than a wrong cursor.
  assert.equal(pickRenderablePresence(ahead, undefined, 0), null);
  // Steps arrived: the new presence is drawn.
  assert.equal(pickRenderablePresence(ahead, before, 3)?.selection?.head, 9);
});

test("someone ELSE typing at a collaborator's caret does not drag their caret along", () => {
  let receiver = editorState("alpha beta", "receiver");
  const buffer: ReceivedMappingEntry[] = [];
  const presence = { anchor: 6, head: 6, from: 6, to: 6, version: 0 };
  // A third client inserts "QQ" exactly at the sender's caret.
  let third = editorState("alpha beta", "third");
  third = typeAt(third, 6, "QQ");
  receiver = receive(receiver, sendableSteps(third)!.steps as Step[], "third", buffer);
  const unconfirmed = sendableSteps(receiver)?.steps.map((step) => step.getMap()) ?? [];
  assert.equal(mapRemoteSelection(presence, getVersion(receiver), buffer, unconfirmed, "sender").head, 6);
});
