// Keyboard-driven markdown editing for plain <textarea> composers (forum
// comments, quicktakes, the studio comment rail). Pure functions over
// {text, start, end} so the behaviour is unit-testable without a DOM; the
// `useMarkdownShortcuts` hook (components/use-markdown-shortcuts.ts) applies
// the returned edit to the real textarea.
//
// Google-Docs-style muscle memory that people expect:
//   Cmd/Ctrl+B, Cmd/Ctrl+I      bold / italic (toggle)
//   Cmd/Ctrl+K                  link — selection becomes the link text, URL
//                               from the clipboard when it holds one
//   select + $ ` * _            wrap the selection ($ = inline LaTeX)
//   select + paste a URL        [selection](url)

export type TextSelection = { text: string; start: number; end: number };

export type KeyInput = {
  key: string;
  /** Cmd on macOS / Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Clipboard text, when the caller could read it (Cmd+K uses a URL). */
  clipboardText?: string | null;
};

export function isUrlLike(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Wrap the selection in `marker` (same string on both sides) and keep the
 * inner text selected. If the selection is already wrapped in that marker,
 * unwrap it instead (so Cmd+B twice is a no-op, like a rich editor).
 */
export function wrapSelection(selection: TextSelection, marker: string, after = marker): TextSelection {
  const { text, start, end } = selection;
  const selected = text.slice(start, end);
  const wrappedAround =
    text.slice(start - marker.length, start) === marker && text.slice(end, end + after.length) === after;
  if (wrappedAround) {
    const next = text.slice(0, start - marker.length) + selected + text.slice(end + after.length);
    return { text: next, start: start - marker.length, end: end - marker.length };
  }
  const wrappedInside =
    selected.length >= marker.length + after.length &&
    selected.startsWith(marker) &&
    selected.endsWith(after);
  if (wrappedInside) {
    const inner = selected.slice(marker.length, selected.length - after.length);
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
  }
  const next = text.slice(0, start) + marker + selected + after + text.slice(end);
  return { text: next, start: start + marker.length, end: end + marker.length };
}

function replaceSelection(
  selection: TextSelection,
  replacement: string,
  selectWithin: string | null
): TextSelection {
  const { text, start, end } = selection;
  const next = text.slice(0, start) + replacement + text.slice(end);
  if (selectWithin) {
    const offset = replacement.indexOf(selectWithin);
    if (offset >= 0) {
      return { text: next, start: start + offset, end: start + offset + selectWithin.length };
    }
  }
  const caret = start + replacement.length;
  return { text: next, start: caret, end: caret };
}

const LINK_TEXT_PLACEHOLDER = "text";
const LINK_URL_PLACEHOLDER = "url";

/** Build a markdown link from the current selection (Cmd/Ctrl+K). */
export function linkEdit(selection: TextSelection, clipboardText?: string | null): TextSelection {
  const selected = selection.text.slice(selection.start, selection.end);
  const clipboardUrl = clipboardText && isUrlLike(clipboardText) ? clipboardText.trim() : null;

  if (selected && isUrlLike(selected)) {
    // The user selected a URL: ask for the visible text.
    return replaceSelection(selection, `[${LINK_TEXT_PLACEHOLDER}](${selected.trim()})`, LINK_TEXT_PLACEHOLDER);
  }
  if (selected) {
    if (clipboardUrl) {
      return replaceSelection(selection, `[${selected}](${clipboardUrl})`, null);
    }
    return replaceSelection(selection, `[${selected}](${LINK_URL_PLACEHOLDER})`, LINK_URL_PLACEHOLDER);
  }
  const url = clipboardUrl ?? LINK_URL_PLACEHOLDER;
  return replaceSelection(selection, `[${LINK_TEXT_PLACEHOLDER}](${url})`, LINK_TEXT_PLACEHOLDER);
}

// Characters that wrap a non-empty selection when typed on their own.
const WRAP_KEYS: Record<string, string> = {
  $: "$",
  "`": "`",
  "*": "*",
  _: "_"
};

/**
 * Translate a keydown into a text edit, or null when the key should be left to
 * the browser. Callers preventDefault() only when an edit is returned.
 */
export function markdownKeyEdit(selection: TextSelection, input: KeyInput): TextSelection | null {
  const hasSelection = selection.end > selection.start;
  if (input.alt) return null;

  if (input.mod) {
    if (input.shift) return null;
    switch (input.key.toLowerCase()) {
      case "b":
        return wrapSelection(selection, "**");
      case "i":
        return wrapSelection(selection, "_");
      case "k":
        return linkEdit(selection, input.clipboardText);
      default:
        return null;
    }
  }

  const marker = WRAP_KEYS[input.key];
  if (marker && hasSelection) {
    return wrapSelection(selection, marker);
  }
  return null;
}

/**
 * Pasting a URL while text is selected turns the selection into a link. Any
 * other paste returns null so the browser performs its default insert.
 */
export function markdownPasteEdit(selection: TextSelection, pasted: string): TextSelection | null {
  if (selection.end <= selection.start) return null;
  if (!isUrlLike(pasted)) return null;
  const selected = selection.text.slice(selection.start, selection.end);
  if (isUrlLike(selected)) return null; // replacing one URL with another — plain paste
  return replaceSelection(selection, `[${selected}](${pasted.trim()})`, null);
}

/** Short hint shown under composers. Kept here so every composer says the same thing. */
export const MARKDOWN_SHORTCUT_HINT =
  "Markdown + LaTeX · ⌘B bold · ⌘I italic · ⌘K link · select + $ math · ⌘↵ post";
