import type { EditorState, Transaction } from "@tiptap/pm/state";

// Node types whose node-views (iframes, images, tables) can paint half-initialized
// right after an AI edit inserts them, and historically needed a forced remount.
const REMOUNT_NODE_TYPES = new Set(["embeddedWidget", "repoImage", "image", "table"]);

// Forces a node-view re-render of widget/image/table nodes WITHOUT replacing the
// document.
//
// The old approach — `editor.commands.setContent(snapshot, false)` — replaced the
// ENTIRE document to force a remount. That full-doc replace caused three distinct
// data bugs:
//   • it collapsed every OTHER in-flight AI selection's anchor to the document end,
//     so concurrent edits' results were inserted at the bottom instead of in place;
//   • the replace step, pushed through collaboration and pulled by another client,
//     overwrote that client's concurrent edits (silent content loss);
//   • it was the original vector for post-AI-edit content reverts.
//
// `setNodeMarkup` on each target node re-sets its attributes in place: the node-view
// re-renders, but no other position moves and no other content is touched, so it is
// safe under collaboration and never disturbs other anchors. Returns null when there
// is nothing to remount (e.g. a text-only edit).
export function buildAiEditRemountTransaction(state: EditorState): Transaction | null {
  const targets: number[] = [];
  state.doc.descendants((node, pos) => {
    if (REMOUNT_NODE_TYPES.has(node.type.name)) targets.push(pos);
  });
  if (targets.length === 0) return null;

  const tr = state.tr;
  for (const pos of targets) {
    const node = tr.doc.nodeAt(pos);
    if (!node) continue;
    tr.setNodeMarkup(pos, undefined, { ...node.attrs }, node.marks);
  }
  return tr.steps.length > 0 ? tr : null;
}
