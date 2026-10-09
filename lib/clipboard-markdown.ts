import { generateJSON } from "@tiptap/html";

import { getDocumentMarkdown } from "@/lib/content";
import { documentEditorExtensions } from "@/lib/document-editor-schema";

// Markup that carries structure the clipboard's text/plain flavour loses
// (lists, headings, emphasis, links…). ProseMirror and Google Docs mark their
// clipboard HTML explicitly. HTML without any of this — e.g. a code editor's
// styled <div>/<span> soup — is left to the plain-text paste, which keeps
// indentation intact.
const RICH_HTML_PATTERN =
  /data-pm-slice|docs-internal-guid|<(ul|ol|li|h[1-6]|blockquote|pre|table|strong|b|em|i|a|code)[\s>]/i;

function stripDataImages(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  const record = node as { type?: string; attrs?: { src?: unknown }; content?: unknown[] };
  if (!Array.isArray(record.content)) return node;
  return {
    ...record,
    content: record.content
      .filter((child) => {
        const c = child as { type?: string; attrs?: { src?: unknown } };
        return !(c?.type === "image" && typeof c.attrs?.src === "string" && c.attrs.src.startsWith("data:"));
      })
      .map(stripDataImages)
  };
}

// Converts rich clipboard HTML (copied from an r-docs document, Google Docs, a
// web page) into the markdown that comment/quicktake composers store, using
// the document schema + the same serializer as document export/MCP. Returns
// null when the HTML adds nothing over the plain-text paste.
export function richClipboardToMarkdown(html: string): string | null {
  if (!html || !RICH_HTML_PATTERN.test(html)) return null;
  try {
    const json = generateJSON(html, documentEditorExtensions());
    const markdown = getDocumentMarkdown(stripDataImages(json), { minimalEscaping: true }).trim();
    return markdown || null;
  } catch {
    return null;
  }
}
