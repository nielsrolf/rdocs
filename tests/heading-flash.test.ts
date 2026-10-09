import assert from "node:assert/strict";
import test from "node:test";

import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState } from "@tiptap/pm/state";

import {
  HEADING_FLASH_CLASS,
  createHeadingFlashPlugin,
  headingFlashKey,
  type FlashMeta
} from "../components/document-workspace/heading-flash";

const schema = getSchema([StarterKit]);

function makeState() {
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "intro" }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Target" }] },
      { type: "paragraph", content: [{ type: "text", text: "body" }] }
    ]
  });
  return EditorState.create({ doc, plugins: [createHeadingFlashPlugin()] });
}

const HEADING_POS = 7; // "intro" paragraph is 7 wide

function flashClasses(state: EditorState) {
  const set = headingFlashKey.get(state)!.props.decorations!.call(headingFlashKey.get(state)!, state);
  const found: { from: number; to: number; cls: string }[] = [];
  // DecorationSet.find returns decorations with their (mapped) ranges.
  for (const deco of (set as unknown as { find(): { from: number; to: number; type: { attrs: { class: string } } }[] }).find()) {
    found.push({ from: deco.from, to: deco.to, cls: deco.type.attrs.class });
  }
  return found;
}

function withMeta(state: EditorState, meta: FlashMeta) {
  return state.apply(state.tr.setMeta(headingFlashKey, meta));
}

test("heading flash decorates the linked heading and clears on request", () => {
  let state = makeState();
  assert.equal(state.doc.nodeAt(HEADING_POS)?.type.name, "heading");
  assert.deepEqual(flashClasses(state), []);

  state = withMeta(state, { pos: HEADING_POS });
  const node = state.doc.nodeAt(HEADING_POS)!;
  assert.deepEqual(flashClasses(state), [
    { from: HEADING_POS, to: HEADING_POS + node.nodeSize, cls: HEADING_FLASH_CLASS }
  ]);

  state = withMeta(state, { clear: true });
  assert.deepEqual(flashClasses(state), []);
});

test("heading flash follows the heading through edits above it", () => {
  let state = withMeta(makeState(), { pos: HEADING_POS });
  state = state.apply(state.tr.insertText("more ", 1));
  const [deco] = flashClasses(state);
  assert.equal(deco.from, HEADING_POS + 5);
  assert.equal(state.doc.nodeAt(deco.from)?.textContent, "Target");
});

test("heading flash disappears when the heading is deleted", () => {
  let state = withMeta(makeState(), { pos: HEADING_POS });
  const size = state.doc.nodeAt(HEADING_POS)!.nodeSize;
  state = state.apply(state.tr.delete(HEADING_POS, HEADING_POS + size));
  assert.deepEqual(flashClasses(state), []);
});

test("heading flash ignores non-heading targets", () => {
  const state = withMeta(makeState(), { pos: 0 });
  assert.deepEqual(flashClasses(state), []);
});
