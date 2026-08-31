import assert from "node:assert/strict";
import test from "node:test";

import { LatexShortcut, LinkShortcut } from "../components/document-workspace/editor-extras";

test("Mod-K passes the live TipTap editor to the link UI callback", () => {
  const liveEditor = { marker: "live-editor" };
  let received: unknown = null;
  const extension = LinkShortcut.configure({
    onOpen: ((editor: unknown) => {
      received = editor;
    }) as () => void
  });
  const addShortcuts = extension.config.addKeyboardShortcuts;
  assert.ok(addShortcuts);
  const shortcuts = addShortcuts.call({
    editor: liveEditor,
    options: extension.options
  } as never);

  assert.equal(shortcuts["Mod-k"]({} as never), true);
  assert.equal(received, liveEditor);
});

test("pressing $ wraps a non-empty text selection as inline LaTeX", () => {
  const calls: Array<[string, unknown]> = [];
  const chain = {
    focus() { calls.push(["focus", null]); return this; },
    insertContentAt(range: unknown, content: unknown) { calls.push(["insertContentAt", { range, content }]); return this; },
    setTextSelection(range: unknown) { calls.push(["setTextSelection", range]); return this; },
    run() { calls.push(["run", null]); return true; }
  };
  const editor = {
    state: {
      selection: { from: 3, to: 8, empty: false },
      doc: { textBetween: () => "x + 1" }
    },
    chain: () => chain
  };
  const extension = LatexShortcut.configure();
  const addShortcuts = extension.config.addKeyboardShortcuts;
  assert.ok(addShortcuts);
  const shortcuts = addShortcuts.call({ editor } as never);

  assert.equal(shortcuts["$"]({} as never), true);
  assert.deepEqual(calls[1], [
    "insertContentAt",
    { range: { from: 3, to: 8 }, content: { type: "text", text: "$x + 1$" } }
  ]);
  assert.deepEqual(calls[2], ["setTextSelection", { from: 4, to: 9 }]);
});

test("pressing $ with no selection keeps normal dollar-sign typing", () => {
  const extension = LatexShortcut.configure();
  const addShortcuts = extension.config.addKeyboardShortcuts;
  assert.ok(addShortcuts);
  const shortcuts = addShortcuts.call({
    editor: { state: { selection: { from: 3, to: 3, empty: true } } }
  } as never);
  assert.equal(shortcuts["$"]({} as never), false);
});
