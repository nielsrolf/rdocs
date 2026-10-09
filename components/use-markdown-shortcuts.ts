"use client";

import type { ClipboardEvent, KeyboardEvent, RefObject } from "react";

import { richClipboardToMarkdown } from "@/lib/clipboard-markdown";
import { markdownKeyEdit, markdownPasteEdit, type TextSelection } from "@/lib/markdown-shortcuts";

// Wires lib/markdown-shortcuts onto a controlled <textarea>: returns keydown /
// paste handlers that apply the pure edits and restore the selection after
// React re-renders the new value. Returns true from the keydown handler when
// it consumed the event so the caller can skip its own handling.
export function useMarkdownShortcuts(
  ref: RefObject<HTMLTextAreaElement | null>,
  onChange: (value: string) => void
) {
  function apply(edit: TextSelection) {
    onChange(edit.text);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(edit.start, edit.end);
    });
  }

  function current(el: HTMLTextAreaElement): TextSelection {
    return { text: el.value, start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    const el = event.currentTarget;
    const mod = event.metaKey || event.ctrlKey;
    const input = { key: event.key, mod, shift: event.shiftKey, alt: event.altKey };
    const selection = current(el);

    if (mod && event.key.toLowerCase() === "k") {
      // Cmd+K: read the clipboard (async) so a copied URL becomes the link
      // target; fall back to the "url" placeholder when unavailable.
      event.preventDefault();
      const read = navigator.clipboard?.readText?.bind(navigator.clipboard);
      const finish = (clipboardText: string | null) => {
        const edit = markdownKeyEdit(selection, { ...input, clipboardText });
        if (edit) apply(edit);
      };
      if (read) {
        read().then(finish, () => finish(null));
      } else {
        finish(null);
      }
      return true;
    }

    const edit = markdownKeyEdit(selection, input);
    if (!edit) return false;
    event.preventDefault();
    apply(edit);
    return true;
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = event.clipboardData?.getData("text/plain") ?? "";
    const selection = current(event.currentTarget);
    const edit = markdownPasteEdit(selection, pasted);
    if (edit) {
      event.preventDefault();
      apply(edit);
      return;
    }
    // Rich content (a list copied from a doc, Google Docs, a web page): its
    // text/plain flavour separates every block with blank lines and drops
    // list markers, so paste the HTML flavour converted to markdown instead.
    const markdown = richClipboardToMarkdown(event.clipboardData?.getData("text/html") ?? "");
    if (!markdown) return;
    event.preventDefault();
    const caret = selection.start + markdown.length;
    apply({
      text: selection.text.slice(0, selection.start) + markdown + selection.text.slice(selection.end),
      start: caret,
      end: caret
    });
  }

  return { onKeyDown, onPaste };
}
