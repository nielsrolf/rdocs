import type { Extensions, JSONContent } from "@tiptap/core";
import ImageExtension from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import StarterKit from "@tiptap/starter-kit";

import { buildAiEditHtml } from "@/components/document-workspace/markdown";
import { getDocumentMarkdown } from "@/lib/content";

// Comments, replies and quicktakes are STORED as markdown — that is what
// agents, MCP, Slack notifications and @mention detection read — but EDITED in
// a small rich-text editor built from the document editor's own nodes. This
// module is the seam between the two, shared by the browser component
// (components/rich-comment-editor.tsx) and the headless round-trip tests.
//
// The node set is deliberately limited to what comment markdown can carry and
// the comment renderer (MarkdownBody, markdown-it) displays: no underline,
// highlights, task lists, widgets or tabs. Data-URL images are rejected
// (allowBase64: false) so a pasted screenshot never inlines megabytes of
// base64 into a comment body.
export function commentEditorExtensions(): Extensions {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
    Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
    ImageExtension.configure({ inline: false, allowBase64: false }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell
  ];
}

// Markdown → editor HTML, on the same markdown-it configuration the AI-edit
// insert path uses (breaks: true like the comment renderer, LaTeX kept as
// literal $…$ text).
export function commentMarkdownToHtml(markdown: string): string {
  return markdown.trim() ? buildAiEditHtml(markdown, []) : "";
}

// Editor JSON → the markdown we store.
export function commentDocToMarkdown(doc: JSONContent): string {
  return getDocumentMarkdown(doc, { minimalEscaping: true }).trim();
}

// Plain-text clipboard content that is evidently markdown (copied from a
// chat, an .md file, a terminal): paste it parsed instead of as literal
// asterisks and dashes.
export function looksLikeMarkdown(text: string): boolean {
  return (
    /^(\s*([-*+]|\d+\.)\s+\S|#{1,6}\s+\S|>\s|```)/m.test(text) ||
    /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`/.test(text)
  );
}
