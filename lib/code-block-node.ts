import CodeBlockBase from "@tiptap/extension-code-block";

/**
 * Code block that accepts annotation marks.
 *
 * TipTap's stock CodeBlock declares `marks: ""`, so `addMark(commentAnchor)` on
 * text inside a code block was a silent no-op: commenting on (or reacting to) a
 * line of a code block failed with "Unable to anchor the comment to the selected
 * text." Formatting marks stay excluded; only the annotation marks that do not
 * change how the text renders are allowed.
 *
 * Like `InlineCode`, this node MUST be registered in both schemas —
 * `lib/document-editor-schema.ts` and the client editor in
 * `components/document-workspace.tsx` — with `StarterKit.configure({ codeBlock: false })`.
 */
export const CODE_BLOCK_MARKS = "commentAnchor aiEditRange";

export const CodeBlock = CodeBlockBase.extend({
  marks: CODE_BLOCK_MARKS
});
