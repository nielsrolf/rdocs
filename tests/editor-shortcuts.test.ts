import assert from "node:assert/strict";
import test from "node:test";

import { LinkShortcut } from "../components/document-workspace/editor-extras";

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
