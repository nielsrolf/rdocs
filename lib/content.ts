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
    };

export const defaultDocumentContent: DocumentContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Start writing. Select text to attach a comment thread, or share the document with a view/comment/edit link."
        }
      ]
    }
  ]
};

export function serializeDocumentContent(content: unknown) {
  return JSON.stringify(content);
}

export function parseDocumentContent(raw: string): DocumentContent {
  try {
    return JSON.parse(raw) as DocumentContent;
  } catch {
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

  return text || defaultDocumentContent.content[0]?.content?.[0]?.text || "";
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
      label?: unknown;
      buildCmd?: unknown;
      embedSource?: unknown;
    } | null;
    appendTextBlock(
      blocks,
      `\n[Interactive widget: ${typeof attrs?.label === "string" ? attrs.label : "Untitled"}; build_cmd=${
        typeof attrs?.buildCmd === "string" ? attrs.buildCmd : "n/a"
      }; embed_source=${typeof attrs?.embedSource === "string" ? attrs.embedSource : "n/a"}]\n`
    );
    return;
  }

  if (nodeType === "repoImage") {
    const attrs = getNodeAttrs(node) as {
      alt?: unknown;
      caption?: unknown;
      path?: unknown;
    } | null;
    appendTextBlock(
      blocks,
      `\n[Repository image: ${typeof attrs?.alt === "string" ? attrs.alt : "Untitled"}; caption=${
        typeof attrs?.caption === "string" ? attrs.caption : "n/a"
      }; path=${typeof attrs?.path === "string" ? attrs.path : "n/a"}]\n`
    );
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
    .filter((block) => block.type === "image" || block.text);

  return normalized.length > 0
    ? normalized
    : [
        {
          type: "text",
          text: defaultDocumentContent.content[0]?.content?.[0]?.text || ""
        }
      ];
}
