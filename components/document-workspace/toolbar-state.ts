import type { Editor } from "@tiptap/react";

import { HIGHLIGHT_COLORS, type HighlightColor } from "@/lib/text-highlight";

// The formatting toolbar's "active" flags, read through `useEditorState` so the
// toolbar follows the caret WITHOUT the whole DocumentWorkspace re-rendering on
// every transaction (the editor runs with shouldRerenderOnTransaction: false —
// per-keystroke and per-remote-step renders of that component were the main
// source of typing lag during live collaboration). `useEditorState` compares
// the result deeply, so the component only re-renders when a flag flips.
export type ToolbarState = {
  h1: boolean;
  h2: boolean;
  h3: boolean;
  paragraph: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
  bulletList: boolean;
  orderedList: boolean;
  taskList: boolean;
  blockquote: boolean;
  toggleBlock: boolean;
  codeBlock: boolean;
  highlight: Record<HighlightColor, boolean>;
};

export function selectToolbarState(editor: Editor): ToolbarState {
  const highlight = {} as Record<HighlightColor, boolean>;
  for (const color of HIGHLIGHT_COLORS) {
    highlight[color] = editor.isActive("textHighlight", { color });
  }
  return {
    h1: editor.isActive("heading", { level: 1 }),
    h2: editor.isActive("heading", { level: 2 }),
    h3: editor.isActive("heading", { level: 3 }),
    paragraph: editor.isActive("paragraph"),
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    underline: editor.isActive("underline"),
    strike: editor.isActive("strike"),
    code: editor.isActive("code"),
    link: editor.isActive("link"),
    bulletList: editor.isActive("bulletList"),
    orderedList: editor.isActive("orderedList"),
    taskList: editor.isActive("taskList"),
    blockquote: editor.isActive("blockquote"),
    toggleBlock: editor.isActive("toggleBlock"),
    codeBlock: editor.isActive("codeBlock"),
    highlight
  };
}
