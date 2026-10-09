"use client";

import { useLayoutEffect, type RefObject } from "react";

// Grows a <textarea> with its content (no inner scrollbar, no upper bound);
// `rows` stays the minimum height. Re-measures whenever `value` changes, so
// programmatic edits (paste conversion, mention insertion) resize too.
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const style = window.getComputedStyle(el);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = `${el.scrollHeight + (Number.isFinite(border) ? border : 0)}px`;
    el.style.overflowY = "hidden";
  }, [ref, value]);
}
