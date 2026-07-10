export type ParagraphNode = {
  type: "paragraph";
  content?: Array<{ type: "text"; text: string }>;
};

export type DocumentContent = {
  type: "doc";
  content: ParagraphNode[];
};

// AiDocumentBlock now lives in agent-core/ so the framework-free agent runtime
// can use it; imported for local use and re-exported to preserve the
// `@/lib/content` import path.
import type { AiDocumentBlock } from "../agent-core/types";
export type { AiDocumentBlock };

export const defaultDocumentContent: DocumentContent = {
  type: "doc",
  content: [
    {
      type: "paragraph"
    }
  ]
};

function stripShareFromAppUrl(value: unknown): unknown {
  if (typeof value !== "string" || !value.startsWith("/api/")) return value;
  const [pathname, query = ""] = value.split("?");
  if (!query) return value;
  const params = new URLSearchParams(query);
  if (!params.has("share")) return value;
  params.delete("share");
  const nextQuery = params.toString();
  return nextQuery ? `${pathname}?${nextQuery}` : pathname;
}

/**
 * Remove bearer capabilities accidentally persisted by legacy clients. This is
 * applied both when reading and writing so old snapshots are safe to display and
 * every subsequent save gradually scrubs the stored document as well.
 */
export function stripPersistedDocumentCapabilities(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripPersistedDocumentCapabilities);
  }
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "shareToken") continue;
    if (key === "src" || key === "href") {
      result[key] = stripShareFromAppUrl(child);
      continue;
    }
    result[key] = stripPersistedDocumentCapabilities(child);
  }
  return result;
}

export function scrubSerializedDocumentCapabilities(raw: string): string {
  try {
    return JSON.stringify(stripPersistedDocumentCapabilities(JSON.parse(raw)));
  } catch {
    // Preserve malformed content for recovery instead of replacing it during a
    // security migration. Normal reads still fall back safely.
    return raw;
  }
}

export function serializeDocumentContent(content: unknown) {
  return JSON.stringify(stripPersistedDocumentCapabilities(content));
}

// Walks a doc-content JSON tree looking for any commentAnchor mark on a text
// node or commentThreadIds attr on a block node that references this thread.
// Used by the comment-create route to refuse creating an orphan thread row.
export function documentHasAnchorForThread(content: unknown, threadId: string): boolean {
  if (!content || typeof content !== "object") return false;
  const node = content as {
    marks?: unknown[];
    attrs?: { commentThreadIds?: unknown };
    content?: unknown[];
  };

  if (Array.isArray(node.marks)) {
    for (const mark of node.marks) {
      if (!mark || typeof mark !== "object") continue;
      const m = mark as { type?: unknown; attrs?: { threadId?: unknown } };
      if (m.type === "commentAnchor" && m.attrs?.threadId === threadId) return true;
    }
  }

  if (Array.isArray(node.attrs?.commentThreadIds)) {
    for (const tid of node.attrs.commentThreadIds as unknown[]) {
      if (tid === threadId) return true;
    }
  }

  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      if (documentHasAnchorForThread(child, threadId)) return true;
    }
  }

  return false;
}

export function parseDocumentContent(raw: string): DocumentContent {
  try {
    return JSON.parse(scrubSerializedDocumentCapabilities(raw)) as DocumentContent;
  } catch (error) {
    console.error("parseDocumentContent: failed to parse stored document JSON", {
      error: error instanceof Error ? error.message : error,
      preview: raw.slice(0, 200)
    });
    return defaultDocumentContent;
  }
}

function extractTextFromNode(node: unknown): string {
  if (!node || typeof node !== "object") {
    return "";
  }

  const typedNode = node as {
    type?: string;
    text?: string;
    content?: unknown[];
    rows?: unknown[];
    cells?: unknown[];
  };

  if (typedNode.type === "text" && typeof typedNode.text === "string") {
    return typedNode.text;
  }

  if (typedNode.type === "embeddedWidget") {
    const attrs = (typedNode as { attrs?: { label?: unknown; buildCmd?: unknown; embedSource?: unknown } }).attrs;
    return `[Interactive widget: ${typeof attrs?.label === "string" ? attrs.label : "Untitled"}]\n\n`;
  }

  if (typedNode.type === "repoImage") {
    const attrs = (typedNode as { attrs?: { alt?: unknown; caption?: unknown; path?: unknown } }).attrs;
    const alt = typeof attrs?.alt === "string" ? attrs.alt : "Repository image";
    const caption = typeof attrs?.caption === "string" ? attrs.caption : "";
    return `[Repository image: ${alt}${caption ? `; ${caption}` : ""}]\n\n`;
  }

  if (typedNode.type === "attachmentChip") {
    const attrs = (typedNode as { attrs?: { fileName?: unknown } }).attrs;
    const fileName = typeof attrs?.fileName === "string" ? attrs.fileName : "Attachment";
    return `[Attachment: ${fileName}]\n\n`;
  }

  // Preserve table structure as GFM so the plain-text haystack (used for
  // findText / anchor matching) stays consistent with what the agent sees.
  if (typedNode.type === "table") {
    const gfm = serializeTableToGfm(node, (cell) => escapeTableCell(extractCellText(cell)));
    return gfm ? `${gfm}\n\n` : "";
  }

  const childText = Array.isArray(typedNode.content)
    ? typedNode.content.map((child) => extractTextFromNode(child)).join("")
    : "";

  switch (typedNode.type) {
    case "paragraph":
    case "heading":
    case "blockquote":
    case "codeBlock":
      return `${childText}\n\n`;
    case "listItem":
      return `${childText}\n`;
    case "taskItem": {
      const checked = (typedNode as { attrs?: { checked?: unknown } }).attrs?.checked === true;
      return `[${checked ? "x" : " "}] ${childText}\n`;
    }
    case "bulletList":
    case "orderedList":
    case "taskList":
      return `${childText}\n`;
    case "tableRow":
      return `${childText}\n`;
    case "tableCell":
    case "tableHeader":
      return `${childText}\t`;
    case "hardBreak":
      return "\n";
    default:
      return childText;
  }
}

export function getDocumentPlainText(content: unknown): string {
  const text = extractTextFromNode(content)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  return text;
}

export function stripCommentAnchorMarks(node: unknown): unknown {
  if (Array.isArray(node)) {
    return mergeAdjacentTextNodes(node.map((child) => stripCommentAnchorMarks(child)));
  }

  if (!node || typeof node !== "object") {
    return node;
  }

  const input = node as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  Object.entries(input).forEach(([key, value]) => {
    if (key === "marks" && Array.isArray(value)) {
      const marks = value
        .filter((mark) => {
          return !mark || typeof mark !== "object" || (mark as { type?: unknown }).type !== "commentAnchor";
        })
        .map((mark) => stripCommentAnchorMarks(mark));

      if (marks.length > 0) {
        output[key] = marks;
      }
      return;
    }

    // Comments on block atoms (embeddedWidget / repoImage / image) are stored as
    // a `commentThreadIds` attr, not an inline mark. Strip it too so that adding
    // or removing such a comment counts as an anchor-only change (parity with the
    // inline commentAnchor mark above).
    if (key === "attrs" && value && typeof value === "object" && !Array.isArray(value)) {
      const attrs = { ...(value as Record<string, unknown>) };
      delete attrs.commentThreadIds;
      output[key] = stripCommentAnchorMarks(attrs);
      return;
    }

    output[key] = stripCommentAnchorMarks(value);
  });

  return output;
}

function mergeAdjacentTextNodes(nodes: unknown[]) {
  const merged: unknown[] = [];

  nodes.forEach((node) => {
    const previous = merged[merged.length - 1];
    if (canMergeTextNodes(previous, node)) {
      (previous as { text: string }).text += (node as { text: string }).text;
      return;
    }

    merged.push(node);
  });

  return merged;
}

function canMergeTextNodes(left: unknown, right: unknown) {
  if (!isTextNode(left) || !isTextNode(right)) {
    return false;
  }

  return JSON.stringify({ ...left, text: undefined }) === JSON.stringify({ ...right, text: undefined });
}

function isTextNode(node: unknown): node is { type: "text"; text: string } {
  return (
    Boolean(node) &&
    typeof node === "object" &&
    (node as { type?: unknown }).type === "text" &&
    typeof (node as { text?: unknown }).text === "string"
  );
}

export function getContextAroundMatch(
  documentText: string,
  anchorText: string,
  radius = 600
): string | null {
  const normalizedDocument = documentText.replace(/\s+/g, " ").trim();
  const normalizedAnchor = anchorText.replace(/\s+/g, " ").trim();

  if (!normalizedDocument || !normalizedAnchor) {
    return null;
  }

  const index = normalizedDocument.toLowerCase().indexOf(normalizedAnchor.toLowerCase());
  if (index === -1) {
    return null;
  }

  const start = Math.max(0, index - radius);
  const end = Math.min(normalizedDocument.length, index + normalizedAnchor.length + radius);

  return normalizedDocument.slice(start, end).trim();
}

function getNodeType(node: unknown) {
  if (!node || typeof node !== "object") {
    return null;
  }

  const type = (node as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

function getNodeAttrs(node: unknown) {
  if (!node || typeof node !== "object") {
    return null;
  }

  const attrs = (node as { attrs?: unknown }).attrs;
  return attrs && typeof attrs === "object" ? attrs : null;
}

function getNodeContent(node: unknown) {
  if (!node || typeof node !== "object") {
    return [];
  }

  const content = (node as { content?: unknown[] }).content;
  return Array.isArray(content) ? content : [];
}

function extractLinkHref(marks: unknown): string | null {
  if (!Array.isArray(marks)) return null;
  for (const mark of marks) {
    if (!mark || typeof mark !== "object") continue;
    if ((mark as { type?: unknown }).type !== "link") continue;
    const href = (mark as { attrs?: { href?: unknown } }).attrs?.href;
    if (typeof href === "string" && href) return href;
  }
  return null;
}

// Serialize a cell's text content for the GFM table paths that don't preserve
// inline marks (plain text + AI blocks). Kept separate from the mark-aware
// markdown path so both round-trip through markdown-it identically.
function extractCellText(cell: unknown): string {
  return getNodeContent(cell)
    .map((child) => extractTextFromNode(child))
    .join("");
}

// Normalize a single table cell for GFM: collapse any internal newlines /
// whitespace to a single line and escape `|` so cell content can't corrupt
// columns. Applied on top of both the mark-aware and plain-text cell renderers,
// so identical input yields identical output across all three table paths.
function escapeTableCell(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

// Render a `table` node as valid GFM: header row, a `| --- |` delimiter row with
// one cell per column, then the body rows. GFM requires a header, so we treat
// the first row as the header even when it is made of plain `tableCell`s.
function serializeTableToGfm(node: unknown, renderCell: (cell: unknown) => string): string {
  const rows = getNodeContent(node).filter((row) => getNodeType(row) === "tableRow");
  if (rows.length === 0) {
    return "";
  }

  const columnCount = Math.max(1, getNodeContent(rows[0]).length);
  const lines: string[] = [];

  rows.forEach((row, rowIndex) => {
    const cells = getNodeContent(row).map((cell) => renderCell(cell));
    lines.push(`| ${cells.join(" | ")} |`);
    if (rowIndex === 0) {
      lines.push(`| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`);
    }
  });

  return lines.join("\n");
}

function appendTextBlock(blocks: AiDocumentBlock[], text: string) {
  const normalized = text.replace(/\s+\n/g, "\n");
  if (!normalized) {
    return;
  }

  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock?.type === "text") {
    lastBlock.text += normalized;
    return;
  }

  blocks.push({
    type: "text",
    text: normalized
  });
}

function visitNodeForAiBlocks(node: unknown, blocks: AiDocumentBlock[]) {
  const nodeType = getNodeType(node);

  if (nodeType === "text") {
    const text = (node as { text?: unknown }).text;
    const raw = typeof text === "string" ? text : "";
    const href = extractLinkHref((node as { marks?: unknown }).marks);
    appendTextBlock(blocks, href ? `[${raw}](${href})` : raw);
    return;
  }

  if (nodeType === "hardBreak") {
    appendTextBlock(blocks, "\n");
    return;
  }

  if (nodeType === "image") {
    const attrs = getNodeAttrs(node) as { src?: unknown; alt?: unknown } | null;
    if (typeof attrs?.src === "string" && attrs.src) {
      blocks.push({
        type: "image",
        src: attrs.src,
        alt: typeof attrs.alt === "string" ? attrs.alt : null
      });
      appendTextBlock(blocks, "\n");
    }
    return;
  }

  if (nodeType === "embeddedWidget") {
    const attrs = getNodeAttrs(node) as {
      widgetId?: unknown;
      label?: unknown;
      buildCmd?: unknown;
      embedSource?: unknown;
      src?: unknown;
    } | null;
    blocks.push({
      type: "widget",
      widgetId: typeof attrs?.widgetId === "string" ? attrs.widgetId : null,
      label: typeof attrs?.label === "string" ? attrs.label : "Untitled",
      buildCmd: typeof attrs?.buildCmd === "string" ? attrs.buildCmd : null,
      embedSource: typeof attrs?.embedSource === "string" ? attrs.embedSource : null,
      src: typeof attrs?.src === "string" ? attrs.src : null
    });
    appendTextBlock(blocks, "\n");
    return;
  }

  if (nodeType === "repoImage") {
    const attrs = getNodeAttrs(node) as {
      src?: unknown;
      alt?: unknown;
      caption?: unknown;
      path?: unknown;
    } | null;
    blocks.push({
      type: "repoImage",
      src: typeof attrs?.src === "string" ? attrs.src : null,
      path: typeof attrs?.path === "string" ? attrs.path : null,
      alt: typeof attrs?.alt === "string" ? attrs.alt : null,
      caption: typeof attrs?.caption === "string" ? attrs.caption : null
    });
    appendTextBlock(blocks, "\n");
    return;
  }

  if (nodeType === "attachmentChip") {
    const attrs = getNodeAttrs(node) as { fileName?: unknown; workspacePath?: unknown } | null;
    const fileName = typeof attrs?.fileName === "string" ? attrs.fileName : "Attachment";
    const workspacePath = typeof attrs?.workspacePath === "string" ? attrs.workspacePath : "";
    appendTextBlock(blocks, `[Attachment: ${fileName}${workspacePath ? ` (${workspacePath})` : ""}]\n`);
    return;
  }

  // Emit tables as GFM so the agent sees real table structure (matching the
  // plain-text haystack) rather than tab-joined cells.
  if (nodeType === "table") {
    const gfm = serializeTableToGfm(node, (cell) => escapeTableCell(extractCellText(cell)));
    if (gfm) {
      appendTextBlock(blocks, `\n${gfm}\n\n`);
    }
    return;
  }

  const children = getNodeContent(node);
  children.forEach((child) => visitNodeForAiBlocks(child, blocks));

  switch (nodeType) {
    case "paragraph":
    case "heading":
    case "blockquote":
    case "codeBlock":
      appendTextBlock(blocks, "\n\n");
      break;
    case "listItem":
    case "taskItem":
    case "bulletList":
    case "orderedList":
    case "taskList":
    case "tableRow":
      appendTextBlock(blocks, "\n");
      break;
    case "tableCell":
    case "tableHeader":
      appendTextBlock(blocks, "\t");
      break;
    default:
      break;
  }
}

type MarkdownContext = {
  listStack: Array<{ ordered: boolean; index: number }>;
  inCodeBlock: boolean;
};

function escapeMarkdown(text: string) {
  return text.replace(/([\\`*_{}\[\]()#+\-.!>])/g, "\\$1");
}

function applyMarks(text: string, marks: unknown): string {
  if (!Array.isArray(marks)) {
    return text;
  }

  let result = text;
  let href: string | null = null;
  let hasCode = false;
  let hasBold = false;
  let hasItalic = false;
  let hasStrike = false;

  for (const mark of marks) {
    if (!mark || typeof mark !== "object") continue;
    const markType = (mark as { type?: unknown }).type;
    if (markType === "link") {
      const attrs = (mark as { attrs?: { href?: unknown } }).attrs;
      if (typeof attrs?.href === "string") {
        href = attrs.href;
      }
    } else if (markType === "code") {
      hasCode = true;
    } else if (markType === "bold") {
      hasBold = true;
    } else if (markType === "italic") {
      hasItalic = true;
    } else if (markType === "strike") {
      hasStrike = true;
    }
  }

  if (hasCode) {
    result = `\`${result}\``;
  } else {
    if (hasStrike) result = `~~${result}~~`;
    if (hasItalic) result = `*${result}*`;
    if (hasBold) result = `**${result}**`;
  }
  if (href) {
    result = `[${result}](${href})`;
  }

  return result;
}

function serializeChildrenToMarkdown(node: unknown, context: MarkdownContext): string {
  const children = getNodeContent(node);
  return children.map((child) => serializeNodeToMarkdown(child, context)).join("");
}

function serializeNodeToMarkdown(node: unknown, context: MarkdownContext): string {
  const nodeType = getNodeType(node);

  if (nodeType === "text") {
    const text = (node as { text?: unknown }).text;
    const raw = typeof text === "string" ? text : "";
    if (context.inCodeBlock) {
      return raw;
    }
    return applyMarks(escapeMarkdown(raw), (node as { marks?: unknown }).marks);
  }

  if (nodeType === "hardBreak") {
    return "  \n";
  }

  if (nodeType === "image") {
    const attrs = getNodeAttrs(node) as { src?: unknown; alt?: unknown } | null;
    const src = typeof attrs?.src === "string" ? attrs.src : "";
    const alt = typeof attrs?.alt === "string" ? attrs.alt : "";
    return src ? `![${alt}](${src})\n\n` : "";
  }

  if (nodeType === "repoImage") {
    const attrs = getNodeAttrs(node) as { src?: unknown; alt?: unknown; caption?: unknown; path?: unknown } | null;
    const path = typeof attrs?.path === "string" && attrs.path
      ? attrs.path
      : typeof attrs?.src === "string" ? attrs.src : "";
    const alt = typeof attrs?.alt === "string" ? attrs.alt : "";
    const caption = typeof attrs?.caption === "string" ? attrs.caption : "";
    const title = caption ? ` "${caption.replace(/"/g, '\\"')}"` : "";
    return path ? `![${alt}](${path}${title})\n\n` : "";
  }

  if (nodeType === "embeddedWidget") {
    const attrs = getNodeAttrs(node) as { widgetId?: unknown; label?: unknown } | null;
    const label = typeof attrs?.label === "string" ? attrs.label : "Interactive widget";
    const widgetId = typeof attrs?.widgetId === "string" ? attrs.widgetId : "";
    // Scannable, round-trippable placeholder (mirrors the ![alt](path) image
    // scan): buildAiEditInsertContent resolves widget://<id> back to the existing
    // widget node, so an agent that echoes a selected widget preserves it instead
    // of pasting literal metadata/link text into the document. Widgets with no id
    // fall back to the widget://new scheme (a freshly-created array widget).
    return `![widget: ${label}](widget://${widgetId || "new"})\n\n`;
  }

  if (nodeType === "attachmentChip") {
    const attrs = getNodeAttrs(node) as { fileName?: unknown; workspacePath?: unknown } | null;
    const fileName = typeof attrs?.fileName === "string" ? attrs.fileName : "Attachment";
    const workspacePath = typeof attrs?.workspacePath === "string" ? attrs.workspacePath : "";
    return `[Attachment: ${fileName}](${workspacePath})\n\n`;
  }

  if (nodeType === "heading") {
    const attrs = getNodeAttrs(node) as { level?: unknown } | null;
    const level = typeof attrs?.level === "number" ? Math.min(6, Math.max(1, attrs.level)) : 2;
    return `${"#".repeat(level)} ${serializeChildrenToMarkdown(node, context).trim()}\n\n`;
  }

  if (nodeType === "paragraph") {
    const body = serializeChildrenToMarkdown(node, context).trim();
    return body ? `${body}\n\n` : "\n";
  }

  if (nodeType === "blockquote") {
    const body = serializeChildrenToMarkdown(node, context).trim();
    return body
      ? `${body.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`
      : "";
  }

  if (nodeType === "codeBlock") {
    const attrs = getNodeAttrs(node) as { language?: unknown } | null;
    const language = typeof attrs?.language === "string" ? attrs.language : "";
    const innerContext: MarkdownContext = { ...context, inCodeBlock: true };
    const body = serializeChildrenToMarkdown(node, innerContext);
    return `\`\`\`${language}\n${body.replace(/\n$/, "")}\n\`\`\`\n\n`;
  }

  if (nodeType === "bulletList" || nodeType === "orderedList") {
    const ordered = nodeType === "orderedList";
    context.listStack.push({ ordered, index: 1 });
    const body = serializeChildrenToMarkdown(node, context);
    context.listStack.pop();
    return `${body}\n`;
  }

  if (nodeType === "taskList") {
    context.listStack.push({ ordered: false, index: 1 });
    const body = serializeChildrenToMarkdown(node, context);
    context.listStack.pop();
    return `${body}\n`;
  }

  if (nodeType === "taskItem") {
    const stack = context.listStack;
    const checked = (getNodeAttrs(node) as { checked?: unknown } | null)?.checked === true;
    const marker = `- [${checked ? "x" : " "}]`;
    const indent = "  ".repeat(Math.max(0, stack.length - 1));
    const body = serializeChildrenToMarkdown(node, context).trim();
    const lines = body.split("\n");
    const first = lines.shift() ?? "";
    const rest = lines
      .map((line) => (line ? `${indent}${" ".repeat(marker.length + 1)}${line}` : ""))
      .join("\n");
    return `${indent}${marker} ${first}${rest ? `\n${rest}` : ""}\n`;
  }

  if (nodeType === "listItem") {
    const stack = context.listStack;
    const current = stack[stack.length - 1] ?? { ordered: false, index: 1 };
    const marker = current.ordered ? `${current.index}.` : "-";
    if (current.ordered) current.index += 1;
    const indent = "  ".repeat(Math.max(0, stack.length - 1));
    const body = serializeChildrenToMarkdown(node, context).trim();
    const lines = body.split("\n");
    const first = lines.shift() ?? "";
    const rest = lines
      .map((line) => (line ? `${indent}${" ".repeat(marker.length + 1)}${line}` : ""))
      .join("\n");
    return `${indent}${marker} ${first}${rest ? `\n${rest}` : ""}\n`;
  }

  if (nodeType === "table") {
    const body = serializeTableToGfm(node, (cell) => escapeTableCell(serializeChildrenToMarkdown(cell, context)));
    return body ? `${body}\n\n` : "";
  }

  return serializeChildrenToMarkdown(node, context);
}

function serializeBlocksToMarkdown(blocks: unknown[]): string {
  const context: MarkdownContext = { listStack: [], inCodeBlock: false };
  return blocks
    .map((block) => serializeNodeToMarkdown(block, context))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeTabTitle(title: string) {
  return title.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function getDocumentMarkdown(content: unknown): string {
  const topLevel = getNodeContent(content);
  const groups: Array<{ title: string | null; nodes: unknown[] }> = [
    { title: null, nodes: [] }
  ];

  for (const child of topLevel) {
    if (getNodeType(child) === "tabBreak") {
      const attrs = getNodeAttrs(child) as { title?: unknown } | null;
      const title = typeof attrs?.title === "string" && attrs.title ? attrs.title : "Untitled tab";
      groups.push({ title, nodes: [] });
      continue;
    }
    groups[groups.length - 1].nodes.push(child);
  }

  const hasBreaks = groups.length > 1;
  if (!hasBreaks) {
    return serializeBlocksToMarkdown(groups[0].nodes);
  }

  // First group with no title only renders if it has content (untitled prelude).
  const sections: string[] = [];
  groups.forEach((group, index) => {
    const body = serializeBlocksToMarkdown(group.nodes);
    if (group.title == null) {
      if (body) sections.push(body);
      return;
    }
    const title = escapeTabTitle(group.title);
    // Tab with no content still emits an empty wrapper so the LLM sees the tab exists.
    sections.push(`<tab title="${title}">\n${body}\n</tab>`);
    void index;
  });

  return sections.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function getDocumentAiBlocks(content: unknown): AiDocumentBlock[] {
  const blocks: AiDocumentBlock[] = [];
  visitNodeForAiBlocks(content, blocks);

  const normalized = blocks
    .map((block) =>
      block.type === "text"
        ? {
            ...block,
            text: block.text.replace(/\n{3,}/g, "\n\n").trim()
          }
        : block
    )
    .filter((block) => block.type !== "text" || block.text);

  return normalized.length > 0 ? normalized : [{ type: "text", text: "" }];
}
