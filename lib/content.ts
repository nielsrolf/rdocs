export type ParagraphNode = {
  type: "paragraph";
  content?: Array<{ type: "text"; text: string }>;
};

export type DocumentContent = {
  type: "doc";
  content: ParagraphNode[];
};

export type AiDocumentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      src: string;
      alt: string | null;
    }
  | {
      type: "repoImage";
      src: string | null;
      path: string | null;
      alt: string | null;
      caption: string | null;
    }
  | {
      type: "widget";
      widgetId: string | null;
      label: string;
      buildCmd: string | null;
      embedSource: string | null;
      src: string | null;
    };

export const defaultDocumentContent: DocumentContent = {
  type: "doc",
  content: [
    {
      type: "paragraph"
    }
  ]
};

export function serializeDocumentContent(content: unknown) {
  return JSON.stringify(content);
}

export function parseDocumentContent(raw: string): DocumentContent {
  try {
    return JSON.parse(raw) as DocumentContent;
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
    case "bulletList":
    case "orderedList":
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
    appendTextBlock(blocks, typeof text === "string" ? text : "");
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
    case "bulletList":
    case "orderedList":
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
    const attrs = getNodeAttrs(node) as { label?: unknown; embedSource?: unknown; buildCmd?: unknown } | null;
    const label = typeof attrs?.label === "string" ? attrs.label : "Interactive widget";
    const source = typeof attrs?.embedSource === "string" ? attrs.embedSource : "";
    const buildCmd = typeof attrs?.buildCmd === "string" ? attrs.buildCmd : "";
    return `[Interactive widget: ${label}](${source})${buildCmd ? ` <!-- build: ${buildCmd} -->` : ""}\n\n`;
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
    return `${serializeChildrenToMarkdown(node, context)}\n`;
  }

  if (nodeType === "tableRow") {
    const cells = getNodeContent(node).map((cell) => serializeChildrenToMarkdown(cell, context).replace(/\s+/g, " ").trim());
    return `| ${cells.join(" | ")} |\n`;
  }

  return serializeChildrenToMarkdown(node, context);
}

export function getDocumentMarkdown(content: unknown): string {
  const context: MarkdownContext = { listStack: [], inCodeBlock: false };
  const text = serializeNodeToMarkdown(content, context)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
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
