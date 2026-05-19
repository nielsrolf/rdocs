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

export function collectCommentAnchorRanges(doc: ProseMirrorDocWithDescendants) {
  const ranges = new Map<string, CommentAnchorRange>();

  doc.descendants((node, pos) => {
    if (!node.isText || !Array.isArray(node.marks)) {
      return;
    }

    node.marks.forEach((mark: { type?: { name?: string }; attrs?: { threadId?: unknown } }) => {
      if (mark.type?.name !== "commentAnchor" || typeof mark.attrs?.threadId !== "string") {
        return;
      }

      const threadId = mark.attrs.threadId;
      const fromPos = pos;
      const toPos = pos + node.nodeSize;
      const current = ranges.get(threadId);
      ranges.set(threadId, {
        threadId,
        fromPos: current ? Math.min(current.fromPos, fromPos) : fromPos,
        toPos: current ? Math.max(current.toPos, toPos) : toPos
      });
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
                return [
                  Decoration.inline(range.fromPos, range.toPos, {
                    class: isActive
                      ? "comment-anchor-highlight comment-anchor-highlight-active"
                      : "comment-anchor-highlight"
                  })
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
