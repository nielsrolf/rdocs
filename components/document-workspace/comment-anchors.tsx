import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { MutableRefObject } from "react";

import type { CommentAnchorRange, HighlightThread, ProseMirrorDocWithDescendants } from "./types";

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
              const decorations = threadsRef.current.flatMap((thread) => {
                const range = resolveCommentAnchorRange(state.doc, thread);
                if (!range) {
                  return [];
                }

                const isActive = thread.id === activeThreadIdRef.current;
                const className = isActive
                  ? "comment-anchor-highlight comment-anchor-highlight-active"
                  : "comment-anchor-highlight";

                const node = state.doc.nodeAt(range.fromPos);
                const isBlockAnchor =
                  !!node &&
                  BLOCK_ANCHOR_NODE_TYPES.has(node.type?.name ?? "") &&
                  range.toPos === range.fromPos + node.nodeSize;

                return [
                  isBlockAnchor
                    ? Decoration.node(range.fromPos, range.toPos, { class: className })
                    : Decoration.inline(range.fromPos, range.toPos, { class: className })
                ];
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
