import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { MutableRefObject } from "react";

// An inline mark on the literal `@Name` text of an @mention in the document
// body. Carries the mentioned user's id so it can be highlighted (self vs.
// other) and re-detected. Mirrors the CommentAnchor mark; it must be registered
// in BOTH the client editor schema and the server schema (document-editor-schema)
// so stored content containing it parses out-of-browser.
export const Mention = Mark.create({
  name: "mention",
  inclusive: false,
  // Default exclusion (only excludes other mentions), so a commentAnchor or
  // aiEditRange mark can still overlap a mention without being dropped.
  addAttributes() {
    return {
      userId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-mention-user-id"),
        renderHTML: (attributes) =>
          typeof attributes.userId === "string" && attributes.userId
            ? { "data-mention-user-id": attributes.userId }
            : {}
      },
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-mention-label"),
        renderHTML: (attributes) =>
          typeof attributes.label === "string" && attributes.label
            ? { "data-mention-label": attributes.label }
            : {}
      }
    };
  },
  parseHTML() {
    return [{ tag: "span[data-mention-user-id]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "mention" }), 0];
  }
});

const mentionDecorationKey = new PluginKey("mentionDecoration");

// Adds `mention-self` / `mention-other` to mention-marked text depending on
// whether the user id matches the viewer. Kept as a decoration (not baked into
// the mark's renderHTML) because "who is me" is a client-only, reactive fact.
export function createMentionDecorationExtension(currentUserIdRef: MutableRefObject<string | null>) {
  return Extension.create({
    name: "mentionDecoration",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: mentionDecorationKey,
          props: {
            decorations(state) {
              const decorations: Decoration[] = [];
              state.doc.descendants((node, pos) => {
                if (!node.isText || !Array.isArray(node.marks)) return;
                const mark = node.marks.find((candidate) => candidate.type.name === "mention");
                if (!mark) return;
                const isSelf =
                  typeof mark.attrs.userId === "string" &&
                  mark.attrs.userId === currentUserIdRef.current;
                decorations.push(
                  Decoration.inline(pos, pos + node.nodeSize, {
                    class: isSelf ? "mention-self" : "mention-other"
                  })
                );
              });
              return DecorationSet.create(state.doc, decorations);
            }
          }
        })
      ];
    }
  });
}

// Build a transaction that replaces the active `@query` range [from,to] with the
// mention text "@label" (carrying the mention mark) plus a trailing space, and
// leaves the cursor after the space. Pure so it can be unit-tested headlessly.
export function buildMentionInsertTransaction(
  state: EditorState,
  range: { from: number; to: number },
  mention: { userId: string; label: string }
): Transaction | null {
  const markType = state.schema.marks.mention;
  if (!markType) return null;
  const from = Math.max(0, Math.min(range.from, state.doc.content.size));
  const to = Math.max(from, Math.min(range.to, state.doc.content.size));
  const text = `@${mention.label}`;
  const mark = markType.create({ userId: mention.userId, label: mention.label });
  const node = state.schema.text(text, [mark]);

  let tr = state.tr.replaceRangeWith(from, to, node);
  // Insert a trailing space WITHOUT the mention mark so typing continues plainly.
  const afterMention = from + node.nodeSize;
  tr = tr.insertText(" ", afterMention);
  tr = tr.removeMark(afterMention, afterMention + 1, markType);
  return tr;
}
