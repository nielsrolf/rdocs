import assert from "node:assert/strict";
import { test } from "node:test";

import { EditorState } from "@tiptap/pm/state";

import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import { createSerialQueue } from "../components/document-workspace/serial-queue";

const schema = createDocumentEditorSchema();

// A tiny stand-in for the live TipTap editor that models exactly the two moves
// applyAiEditRun makes around its network round-trip (components/document-workspace.tsx):
//   1. it edits the doc, then captures `contentToSave = editor.getJSON()` (a snapshot),
//   2. after awaiting the server it calls `editor.commands.setContent(contentToSave)`
//      to force a node-view remount — which REPLACES the whole document.
// If a second run edits the doc in between, that setContent resets the document to a
// stale snapshot and silently drops the other run's content. This is the real
// 9095→1886-byte revert seen in the incident (questions answered, then wiped).
function makeEditor(text: string) {
  let state = EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
    }),
  });
  return {
    append(textToAdd: string) {
      // Insert at the end of the first paragraph (its closing position).
      const pos = state.doc.firstChild ? state.doc.firstChild.nodeSize - 1 : 0;
      state = state.apply(state.tr.insertText(textToAdd, Math.max(1, pos)));
    },
    snapshot() {
      return state.doc.toJSON();
    },
    setContent(json: unknown) {
      state = EditorState.create({ doc: schema.nodeFromJSON(json as never) });
    },
    text() {
      return state.doc.textContent;
    },
  };
}

// Mirrors applyAiEditRun: edit, snapshot, await the server, then remount via setContent.
async function applyRun(editor: ReturnType<typeof makeEditor>, marker: string, wait: () => Promise<void>) {
  editor.append(marker);
  const snapshot = editor.snapshot();
  await wait();
  editor.setContent(snapshot);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("BUG REPRO: two concurrent applies clobber each other via stale setContent", async () => {
  const editor = makeEditor("Q1 Q2 Q3 ");
  const gateWidget = deferred();
  const gateAnswers = deferred();

  // Both runs start (fire-and-forget, as the polling effect dispatches them today):
  // widget edits + snapshots first, then answers edits + snapshots on top.
  const widget = applyRun(editor, "[WIDGET]", () => gateWidget.promise);
  await Promise.resolve();
  const answers = applyRun(editor, "[ANSWERS]", () => gateAnswers.promise);
  await Promise.resolve();

  // The answers run finishes first (its snapshot has both edits)...
  gateAnswers.resolve();
  await answers;
  // ...then the widget run's setContent lands last with its STALE snapshot.
  gateWidget.resolve();
  await widget;

  // The answers were silently dropped — exactly the reported failure.
  assert.ok(!editor.text().includes("[ANSWERS]"), "concurrency repro should lose the answers");
});

test("serializing the applies preserves every run's content", async () => {
  const editor = makeEditor("Q1 Q2 Q3 ");
  const queue = createSerialQueue();

  // The polling effect routes each apply through the queue; they run strictly
  // one-after-another even though both are kicked off "at once".
  await Promise.all([
    queue.run(() => applyRun(editor, "[WIDGET]", () => Promise.resolve())),
    queue.run(() => applyRun(editor, "[ANSWERS]", () => Promise.resolve())),
  ]);

  assert.ok(editor.text().includes("[WIDGET]"), "widget content survives");
  assert.ok(editor.text().includes("[ANSWERS]"), "answers content survives");
  assert.ok(editor.text().includes("Q1 Q2 Q3"), "original content survives");
});

test("createSerialQueue never overlaps tasks and preserves call order", async () => {
  const queue = createSerialQueue();
  const events: string[] = [];
  let active = 0;

  function task(name: string) {
    return async () => {
      active += 1;
      assert.equal(active, 1, `task ${name} must not overlap another`);
      events.push(`start:${name}`);
      await Promise.resolve();
      await Promise.resolve();
      events.push(`end:${name}`);
      active -= 1;
    };
  }

  await Promise.all([queue.run(task("a")), queue.run(task("b")), queue.run(task("c"))]);

  assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
});

test("createSerialQueue keeps running after a task throws", async () => {
  const queue = createSerialQueue();
  const ran: string[] = [];

  const failing = queue.run(async () => {
    throw new Error("boom");
  });
  const next = queue.run(async () => {
    ran.push("next");
  });

  await assert.rejects(failing, /boom/);
  await next;
  assert.deepEqual(ran, ["next"]);
});
