import { generateJSON } from "@tiptap/html";
import type { JSONContent } from "@tiptap/react";

import {
  buildAiEditInsertContent,
  normalizeWidgetsOutsideTables,
  type ExistingWidget
} from "@/components/document-workspace/ai-edit-insert";
import { documentEditorExtensions } from "@/lib/document-editor-schema";

export type WidgetRowForMarkdown = {
  id: string;
  label: string;
  buildCmd: string;
  embedSource: string;
};

export function widgetSourceUrl(documentId: string, widgetId: string) {
  return `/api/documents/${documentId}/widgets/${widgetId}/source`;
}

function toExistingWidget(documentId: string, row: WidgetRowForMarkdown): ExistingWidget {
  return {
    widgetId: row.id,
    label: row.label,
    buildCmd: row.buildCmd,
    embedSource: row.embedSource,
    src: widgetSourceUrl(documentId, row.id)
  };
}

// Server-side markdown → document nodes, on the exact pipeline the browser
// uses for AI-edit results (buildAiEditInsertContent → markdown-it HTML →
// TipTap parse), so `![widget: label](widget://<id>)` placeholders and
// repo-relative image paths resolve identically. Widgets are resolved against
// the document's EmbeddedWidget rows (they may not be embedded in the content
// yet — e.g. just created via the MCP create_widget tool).
export function markdownToDocNodes(input: {
  markdown: string;
  documentId: string;
  widgetRows: WidgetRowForMarkdown[];
}): JSONContent[] {
  const html = buildAiEditInsertContent({
    replacementText: input.markdown,
    sourceLinks: [],
    images: [],
    widgets: [],
    documentId: input.documentId,
    shareToken: null,
    existingWidgets: input.widgetRows.map((row) => toExistingWidget(input.documentId, row))
  });

  const parsed = generateJSON(html, documentEditorExtensions()) as JSONContent;
  const { content } = normalizeWidgetsOutsideTables(parsed);
  return content.content ?? [];
}
