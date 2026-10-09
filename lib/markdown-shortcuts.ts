// Composers (forum comments, quicktakes, the studio comment rail) are rich-text
// editors whose value is markdown — see components/rich-comment-editor.tsx.
// Markdown typed inline ("- ", "# ", "**x**", "`x`") converts as you type.

/** Short hint shown under composers. Kept here so every composer says the same thing. */
export const MARKDOWN_SHORTCUT_HINT =
  "Type - # > ``` for lists, headings, quotes, code · ⌘B bold · ⌘I italic · ⌘K link · select + $ math · ⌘↵ post";
