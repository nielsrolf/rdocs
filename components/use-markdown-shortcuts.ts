"use client";

import type { ClipboardEvent, KeyboardEvent, RefObject } from "react";

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
    const edit = markdownPasteEdit(current(event.currentTarget), pasted);
    if (!edit) return;
    event.preventDefault();
    apply(edit);
  }

  return { onKeyDown, onPaste };
}
