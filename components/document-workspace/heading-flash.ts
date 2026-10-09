import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// Briefly highlights a heading after a "#<slug>" link navigates to it, so the
// reader sees which heading the link meant. Implemented as a node decoration
// (not a DOM class) so collab steps / re-renders during the animation neither
// strip it nor leave it behind; the position is mapped through every edit.

export const HEADING_FLASH_CLASS = "heading-link-flash";
export const HEADING_FLASH_MS = 3200;

export type FlashMeta = { pos: number } | { clear: true };

export const headingFlashKey = new PluginKey<number | null>("headingFlash");

function decorationsFor(state: EditorState, pos: number | null) {
  if (pos === null) return DecorationSet.empty;
  const node = state.doc.nodeAt(pos);
  if (!node || node.type.name !== "heading") return DecorationSet.empty;
  return DecorationSet.create(state.doc, [
    Decoration.node(pos, pos + node.nodeSize, { class: HEADING_FLASH_CLASS })
  ]);
}

// Plain ProseMirror plugin (exported so tests can drive it without a view).
export function createHeadingFlashPlugin() {
  return new Plugin<number | null>({
    key: headingFlashKey,
    state: {
      init: () => null,
      apply(tr, pos, _old, newState) {
        const meta = tr.getMeta(headingFlashKey) as FlashMeta | undefined;
        if (meta) return "clear" in meta ? null : meta.pos;
        if (pos === null || !tr.docChanged) return pos;
        const mapped = tr.mapping.mapResult(pos, 1);
        if (mapped.deleted) return null;
        return newState.doc.nodeAt(mapped.pos)?.type.name === "heading" ? mapped.pos : null;
      }
    },
    props: {
      decorations(state) {
        return decorationsFor(state, headingFlashKey.getState(state) ?? null);
      }
    }
  });
}

export const HeadingFlash = Extension.create({
  name: "headingFlash",
  addProseMirrorPlugins() {
    return [createHeadingFlashPlugin()];
  }
});

const clearTimers = new WeakMap<Editor, ReturnType<typeof setTimeout>>();

// Flash the heading node starting at `pos`. Re-flashing restarts the
// animation (the decoration is removed first so the class is re-applied).
// Returns false when `pos` is not a heading (e.g. a "#tab=<id>" target).
export function flashHeadingAt(editor: Editor, pos: number): boolean {
  if (editor.isDestroyed) return false;
  if (editor.state.doc.nodeAt(pos)?.type.name !== "heading") return false;
  const previous = clearTimers.get(editor);
  if (previous) clearTimeout(previous);
  const dispatch = (meta: FlashMeta) => {
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(headingFlashKey, meta).setMeta("addToHistory", false));
  };
  dispatch({ clear: true });
  const start = () => dispatch({ pos });
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(start);
  else start();
  clearTimers.set(
    editor,
    setTimeout(() => dispatch({ clear: true }), HEADING_FLASH_MS)
  );
  return true;
}
