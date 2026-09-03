import Code from "@tiptap/extension-code";

/**
 * Inline code that lets annotation marks coexist with it.
 *
 * TipTap's stock `Code` mark declares `excludes: "_"` (every other mark). That is
 * fine for formatting, but it also made ProseMirror silently DROP `commentAnchor`,
 * `suggestedInsertion`/`suggestedDeletion`, `aiEditRange`, `textHighlight` and
 * `mention` marks whenever they were added over code-formatted text — `addMark`
 * does not fail, the step is accepted by the collab pipeline, and the anchor just
 * never exists. Users saw it as "Anchor not yet saved. Please retry in a moment."
 * on every comment placed on an inline-code word.
 *
 * So inline code now excludes only the formatting marks (and itself). This mark
 * MUST be registered in both schemas — `lib/document-editor-schema.ts` (server /
 * collab-step validation / markdown import) and the client editor in
 * `components/document-workspace.tsx` — with `StarterKit.configure({ code: false })`.
 */
export const INLINE_CODE_EXCLUDES = "code bold italic strike underline link textHighlight";

export const InlineCode = Code.extend({
  excludes: INLINE_CODE_EXCLUDES
});
