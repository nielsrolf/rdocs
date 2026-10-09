"use client";

import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { LatexShortcut } from "@/components/document-workspace/editor-extras";
import {
  commentDocToMarkdown,
  commentEditorExtensions,
  commentMarkdownToHtml,
  looksLikeMarkdown
} from "@/lib/comment-editor";
import {
  filterMentionCandidates,
  findActiveMentionQuery,
  mentionHandle,
  type MentionCandidate
} from "@/lib/mentions";

type MentionMenu = {
  items: MentionCandidate[];
  index: number;
  // Document range of "@query" (trigger through caret) to replace.
  from: number;
  to: number;
};

// The in-progress "@query" before the caret, if any. Text is read with one
// placeholder char per inline leaf (hard break, image) so string offsets map
// 1:1 onto document positions inside the textblock.
function activeMention(editor: Editor, members: MentionCandidate[]): MentionMenu | null {
  const { selection } = editor.state;
  const { $from } = selection;
  if (!selection.empty || !$from.parent.isTextblock || members.length === 0) return null;
  if ($from.parent.type.name === "codeBlock") return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const active = findActiveMentionQuery(before, before.length);
  if (!active) return null;
  const items = filterMentionCandidates(active.query, members);
  if (items.length === 0) return null;
  return { items, index: 0, from: $from.start() + active.start, to: $from.pos };
}

function isUrl(text: string) {
  return /^(https?:\/\/|mailto:)\S+$/i.test(text.trim());
}

// Rich-text composer for comments, replies and quicktakes. The VALUE is
// markdown (what we store — see lib/comment-editor.ts); editing is WYSIWYG on
// the document editor's own nodes, so lists, headings, code, quotes, tables
// and links behave as in a doc, and content copied from a doc pastes with its
// structure. @mentions stay plain "@Name" text (detected server-side), with
// the same autocomplete the textarea had.
export function RichCommentEditor({
  value,
  onChange,
  members,
  placeholder,
  rows = 3,
  autoFocus,
  disabled,
  className,
  onSubmit
}: {
  value: string;
  onChange: (value: string) => void;
  members: MentionCandidate[];
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
  // Cmd/Ctrl+Enter. Defaults to submitting the enclosing <form>, if any.
  onSubmit?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<MentionMenu | null>(null);
  // ProseMirror callbacks are bound once; read the latest props/state via refs.
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const membersRef = useRef(members);
  membersRef.current = members;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  // The markdown we last reported, so a parent echoing it back is a no-op and
  // only a genuinely external value (reset after posting, a draft swap) reloads.
  const lastEmittedRef = useRef(value);
  const editorRef = useRef<Editor | null>(null);

  function refreshMenu(editor: Editor) {
    const next = activeMention(editor, membersRef.current);
    setMenu((current) =>
      next && current && current.from === next.from
        ? { ...next, index: Math.min(current.index, next.items.length - 1) }
        : next
    );
  }

  function chooseMention(candidate: MentionCandidate) {
    const editor = editorRef.current;
    const active = menuRef.current;
    if (!editor || !active) return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: active.from, to: active.to }, { type: "text", text: `@${mentionHandle(candidate)} ` })
      .run();
    setMenu(null);
  }

  function submit() {
    if (onSubmitRef.current) {
      onSubmitRef.current();
      return;
    }
    wrapRef.current?.closest("form")?.requestSubmit();
  }

  async function toggleLink(editor: Editor) {
    if (editor.isActive("link")) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    let href: string | null = null;
    try {
      const clip = await navigator.clipboard?.readText?.();
      if (clip && isUrl(clip)) href = clip.trim();
    } catch {
      // Clipboard read refused — fall back to asking.
    }
    href = href ?? window.prompt("Link URL")?.trim() ?? null;
    if (!href) return;
    const { empty } = editor.state.selection;
    if (empty) {
      editor.chain().focus().insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
  }

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      ...commentEditorExtensions(),
      LatexShortcut,
      Placeholder.configure({ placeholder: placeholder ?? "" })
    ],
    content: commentMarkdownToHtml(value),
    editable: !disabled,
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: { class: "rich-comment-editor-content" },
      handleKeyDown(_view, event) {
        const active = menuRef.current;
        if (active) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setMenu({ ...active, index: (active.index + step + active.items.length) % active.items.length });
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            chooseMention(active.items[active.index] ?? active.items[0]);
            return true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setMenu(null);
            return true;
          }
        }
        const mod = event.metaKey || event.ctrlKey;
        if (mod && event.key === "Enter") {
          event.preventDefault();
          submit();
          return true;
        }
        if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
          event.preventDefault();
          if (editorRef.current) void toggleLink(editorRef.current);
          return true;
        }
        return false;
      },
      handlePaste(_view, event) {
        // Rich HTML (from a doc, Google Docs, a web page) is parsed by
        // ProseMirror against the comment schema. Plain text that is clearly
        // markdown gets parsed as markdown instead of pasted literally.
        const data = event.clipboardData;
        if (!data || data.getData("text/html")) return false;
        const text = data.getData("text/plain");
        if (!text || !looksLikeMarkdown(text) || !editorRef.current) return false;
        event.preventDefault();
        editorRef.current.chain().focus().insertContent(commentMarkdownToHtml(text)).run();
        return true;
      }
    },
    onCreate({ editor: created }) {
      editorRef.current = created;
    },
    onUpdate({ editor: updated }) {
      const markdown = commentDocToMarkdown(updated.getJSON());
      lastEmittedRef.current = markdown;
      onChangeRef.current(markdown);
      refreshMenu(updated);
    },
    onSelectionUpdate({ editor: updated }) {
      refreshMenu(updated);
    },
    onBlur() {
      // Let a click on a menu option register before closing.
      window.setTimeout(() => setMenu(null), 120);
    }
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor || value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    editor.commands.setContent(commentMarkdownToHtml(value), false);
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  return (
    <div
      className={`rich-comment-editor mention-textarea-wrap${className ? ` ${className}` : ""}${disabled ? " rich-comment-editor-disabled" : ""}`}
      ref={wrapRef}
      style={{ "--rce-rows": rows } as CSSProperties}
    >
      <EditorContent editor={editor} />
      {menu ? (
        <div className="mention-suggest mention-suggest-textarea" role="listbox">
          {menu.items.map((candidate, itemIndex) => (
            <button
              key={candidate.id}
              type="button"
              role="option"
              aria-selected={itemIndex === menu.index}
              className={`mention-suggest-item${itemIndex === menu.index ? " mention-suggest-item-active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                chooseMention(candidate);
              }}
              onMouseEnter={() => setMenu({ ...menu, index: itemIndex })}
            >
              <span className="mention-suggest-name">{candidate.name || candidate.email}</span>
              {candidate.name && candidate.email ? (
                <span className="mention-suggest-email">{candidate.email}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
