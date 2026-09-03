import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { MutableRefObject } from "react";

import type { CommentAnchorRange, HighlightThread, ProseMirrorDocWithDescendants } from "./types";
import { footnoteNumberByThreadId, isFootnoteThread } from "./comment-footnotes";

export const CommentAnchor = Mark.create({
  name: "commentAnchor",
  inclusive: false,
  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-comment-thread-id"),
        renderHTML: (attributes) =>
          typeof attributes.threadId === "string" && attributes.threadId
            ? { "data-comment-thread-id": attributes.threadId }
            : {}
      }
    };
  },
  parseHTML() {
    return [{ tag: "span[data-comment-thread-id]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  }
});

const BLOCK_ANCHOR_NODE_TYPES = new Set(["embeddedWidget", "repoImage", "image"]);

export function collectCommentAnchorRanges(doc: ProseMirrorDocWithDescendants) {
  const ranges = new Map<string, CommentAnchorRange>();

  function record(threadId: string, fromPos: number, toPos: number) {
    const current = ranges.get(threadId);
    ranges.set(threadId, {
      threadId,
      fromPos: current ? Math.min(current.fromPos, fromPos) : fromPos,
      toPos: current ? Math.max(current.toPos, toPos) : toPos
    });
  }

  doc.descendants((node, pos) => {
    const typeName = (node as { type?: { name?: string } }).type?.name;
    if (typeName && BLOCK_ANCHOR_NODE_TYPES.has(typeName)) {
      const attrs = (node as { attrs?: { commentThreadIds?: unknown } }).attrs;
      const ids = Array.isArray(attrs?.commentThreadIds) ? attrs.commentThreadIds : [];
      for (const id of ids) {
        if (typeof id === "string" && id) {
          record(id, pos, pos + node.nodeSize);
        }
      }
    }

    if (!node.isText || !Array.isArray(node.marks)) {
      return;
    }

    node.marks.forEach((mark: { type?: { name?: string }; attrs?: { threadId?: unknown } }) => {
      if (mark.type?.name !== "commentAnchor" || typeof mark.attrs?.threadId !== "string") {
        return;
      }

      record(mark.attrs.threadId, pos, pos + node.nodeSize);
    });
  });

  return ranges;
}

export function resolveCommentAnchorRange(
  doc: ProseMirrorDocWithDescendants,
  thread: HighlightThread
) {
  return collectCommentAnchorRanges(doc).get(thread.id) ?? null;
}

export function shouldHighlightCommentThread(thread: HighlightThread): boolean {
  return thread.status !== "RESOLVED";
}

// Builds a transaction that anchors `threadId` over the given range, handling
// the mixed-content case that the old inline-only / single-node-only logic
// could not: a selection (e.g. "select all") spanning text *and* block atoms.
// Every block atom (widget / repoImage / image) fully inside the range gets the
// thread id added to its `commentThreadIds` attr, and the inline `commentAnchor`
// mark is applied to any text in the range. Returns null only when there is
// nothing anchorable in the range (so the caller can surface a real error).
export function buildCommentAnchorTransaction(
  state: EditorState,
  range: { from: number; to: number },
  threadId: string
): Transaction | null {
  const from = Math.max(0, Math.min(range.from, state.doc.content.size));
  const to = Math.max(from, Math.min(range.to, state.doc.content.size));
  const markType = state.schema.marks.commentAnchor;

  let tr = state.tr;
  let anchored = false;
  let hasInlineText = false;

  state.doc.nodesBetween(from, to, (node, pos) => {
    const typeName = node.type?.name ?? "";
    if (BLOCK_ANCHOR_NODE_TYPES.has(typeName) && pos >= from && pos + node.nodeSize <= to) {
      const existing = Array.isArray(node.attrs?.commentThreadIds)
        ? (node.attrs.commentThreadIds as string[])
        : [];
      if (!existing.includes(threadId)) {
        tr = tr.setNodeAttribute(pos, "commentThreadIds", [...existing, threadId]);
      }
      anchored = true;
    }
    if (node.isText) {
      hasInlineText = true;
    }
    return true;
  });

  if (markType && hasInlineText) {
    // addMark (unlike TextSelection-based setMark) tolerates range endpoints that
    // fall on atom boundaries; it only marks inline content, skipping block atoms.
    tr = tr.addMark(from, to, markType.create({ threadId }));
    // addMark silently drops the mark wherever another mark excludes it (a
    // `excludes: "_"` code mark did exactly that), so verify it actually landed
    // instead of pushing a no-op step and letting the server 409 on the anchor.
    if (collectCommentAnchorRanges(tr.doc).has(threadId)) {
      anchored = true;
    }
  }

  if (!anchored) {
    return null;
  }

  // Collapse the selection to a safe cursor near the range end. TextSelection.near
  // avoids the "endpoint not pointing into a node with inline content" throw that
  // a raw TextSelection at an atom boundary would raise.
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(to, tr.doc.content.size))));
  return tr;
}

export function createCommentHighlightExtension(
  threadsRef: MutableRefObject<HighlightThread[]>,
  activeThreadIdRef: MutableRefObject<string | null>,
  onActivateThread: (threadId: string | null) => void
) {
  return Extension.create({
    name: "commentHighlight",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("commentHighlight"),
          props: {
            decorations(state) {
              const resolvedThreads = threadsRef.current.filter(shouldHighlightCommentThread).map((thread) => ({
                thread,
                range: resolveCommentAnchorRange(state.doc, thread)
              }));
              const footnoteNumbers = footnoteNumberByThreadId(
                resolvedThreads.flatMap(({ thread, range }) =>
                  range ? [{ ...thread, id: thread.id, position: range.fromPos }] : []
                )
              );
              const decorations = resolvedThreads.flatMap(({ thread, range }) => {
                if (!range) {
                  return [];
                }

                const isActive = thread.id === activeThreadIdRef.current;
                const isFootnote = isFootnoteThread(thread);
                const className = isFootnote
                  ? `footnote-anchor${isActive ? " footnote-anchor-active" : ""}`
                  : isActive
                    ? "comment-anchor-highlight comment-anchor-highlight-active"
                    : "comment-anchor-highlight";

                const node = state.doc.nodeAt(range.fromPos);
                const isBlockAnchor =
                  !!node &&
                  BLOCK_ANCHOR_NODE_TYPES.has(node.type?.name ?? "") &&
                  range.toPos === range.fromPos + node.nodeSize;

                const anchors = [
                  isBlockAnchor
                    ? Decoration.node(range.fromPos, range.toPos, { class: className })
                    : Decoration.inline(range.fromPos, range.toPos, { class: className })
                ];
                const number = footnoteNumbers.get(thread.id);
                if (isFootnote && number) {
                  anchors.push(
                    Decoration.widget(
                      range.toPos,
                      () => {
                        const marker = document.createElement("sup");
                        marker.className = `footnote-marker${isActive ? " footnote-marker-active" : ""}`;
                        marker.textContent = String(number);
                        marker.setAttribute("aria-label", `Footnote ${number}`);
                        marker.setAttribute("role", "button");
                        marker.addEventListener("mousedown", (event) => event.preventDefault());
                        marker.addEventListener("click", () => onActivateThread(thread.id));
                        return marker;
                      },
                      { key: `footnote-marker:${thread.id}:${number}` }
                    )
                  );
                }
                return anchors;
              });

              return DecorationSet.create(state.doc, decorations);
            },
            handleClick(view, pos) {
              const thread = threadsRef.current.find((candidate) => {
                const range = resolveCommentAnchorRange(view.state.doc, candidate);
                return range && pos >= range.fromPos && pos <= range.toPos;
              });

              onActivateThread(thread?.id ?? null);
              return false;
            }
          }
        })
      ];
    }
  });
}
