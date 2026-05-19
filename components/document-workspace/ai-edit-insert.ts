import type { JSONContent } from "@tiptap/react";

import { buildAiEditHtml } from "./markdown";
import type { AiEditImage, AiEditWidget } from "./types";
import { escapeHtml, getImagePathFromSource, isImageSource } from "./utils";

function toRepoImageNode(image: AiEditImage) {
  return `<figure data-repo-image src="${escapeHtml(image.src)}" alt="${escapeHtml(image.alt)}" caption="${escapeHtml(
    image.caption ?? ""
  )}" path="${escapeHtml(image.path ?? image.src)}"></figure>`;
}

function toWidgetNode(widget: AiEditWidget, documentId: string, shareToken: string | null) {
  return `<div data-embedded-widget widgetId="${escapeHtml(widget.id)}" documentId="${escapeHtml(
    documentId
  )}" shareToken="${escapeHtml(shareToken ?? "")}" label="${escapeHtml(widget.label)}" buildCmd="${escapeHtml(
    widget.buildCmd
  )}" embedSource="${escapeHtml(widget.embedSource)}" src="${escapeHtml(widget.src)}" collapsed="true"></div>`;
}

function resolveMarkdownImage(input: {
  src: string;
  alt: string;
  imagesByPath: Map<string, AiEditImage>;
  documentId: string;
  shareToken: string | null;
}) {
  const path = getImagePathFromSource(input.src);
  const matchedImage = input.imagesByPath.get(path) ?? input.imagesByPath.get(input.src.trim());

  if (matchedImage) {
    return matchedImage;
  }

  const isAppRepoFile = input.src.includes(`/api/documents/${input.documentId}/repo-files`);
  if (!isImageSource(path) && !isAppRepoFile) {
    return null;
  }

  const isRemoteOrAppSource = /^(https?:|data:|blob:|\/api\/)/i.test(input.src.trim());
  const src = isRemoteOrAppSource
    ? input.src.trim()
    : `/api/documents/${input.documentId}/repo-files?path=${encodeURIComponent(path)}${
        input.shareToken ? `&share=${encodeURIComponent(input.shareToken)}` : ""
      }`;

  return {
    path,
    src,
    alt: input.alt || path.split("/").pop() || "Figure",
    caption: input.alt || null
  };
}

export function buildAiEditInsertContent(input: {
  replacementText: string;
  sourceLinks: string[];
  images: AiEditImage[];
  widgets: AiEditWidget[];
  documentId: string;
  shareToken: string | null;
}) {
  const imagesByPath = new Map<string, AiEditImage>();
  input.images.forEach((image) => {
    if (image.path) {
      imagesByPath.set(getImagePathFromSource(image.path), image);
    }
    imagesByPath.set(getImagePathFromSource(image.src), image);
  });

  const usedImagePaths = new Set<string>();
  const content: string[] = [];
  const markdownImagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(?<!\!)\[([^\]]+)\]\(([^)\s]+)\)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = markdownImagePattern.exec(input.replacementText)) !== null) {
    const alt = match[1] ?? match[3] ?? "";
    const src = match[2] ?? match[4] ?? "";
    const image = resolveMarkdownImage({
      src,
      alt,
      imagesByPath,
      documentId: input.documentId,
      shareToken: input.shareToken
    });

    if (!image) {
      continue;
    }

    const before = input.replacementText.slice(cursor, match.index).trim();
    if (before) {
      content.push(buildAiEditHtml(before, []));
    }
    content.push(toRepoImageNode(image));
    usedImagePaths.add(getImagePathFromSource(image.path ?? image.src));
    cursor = match.index + match[0].length;
  }

  const after = input.replacementText.slice(cursor).trim();
  if (after) {
    content.push(buildAiEditHtml(after, input.sourceLinks));
  } else if (input.sourceLinks.length > 0) {
    content.push(buildAiEditHtml("", input.sourceLinks));
  }

  input.images
    .filter((image) => !usedImagePaths.has(getImagePathFromSource(image.path ?? image.src)))
    .forEach((image) => {
      content.push(toRepoImageNode(image));
    });

  input.widgets.forEach((widget) => {
    content.push(toWidgetNode(widget, input.documentId, input.shareToken));
  });

  return content.length > 0 ? content.join("\n") : "<p></p>";
}

export function normalizeWidgetsOutsideTables(content: JSONContent) {
  let changed = false;

  function visit(node: JSONContent, insideTable: boolean): { nodes: JSONContent[]; hoisted: JSONContent[] } {
    if (insideTable && node.type === "embeddedWidget") {
      changed = true;
      return { nodes: [], hoisted: [{ ...node }] };
    }

    const nodeIsTable = node.type === "table";
    const nextContent: JSONContent[] = [];
    const hoisted: JSONContent[] = [];

    for (const child of node.content ?? []) {
      const visited = visit(child, insideTable || nodeIsTable);
      nextContent.push(...visited.nodes);
      hoisted.push(...visited.hoisted);
    }

    const nextNode =
      node.content && nextContent.length !== node.content.length
        ? {
            ...node,
            content:
              insideTable && (node.type === "tableCell" || node.type === "tableHeader") && nextContent.length === 0
                ? [{ type: "paragraph" }]
                : nextContent
          }
        : node.content
          ? {
              ...node,
              content:
                insideTable && (node.type === "tableCell" || node.type === "tableHeader") && nextContent.length === 0
                  ? [{ type: "paragraph" }]
                  : nextContent
            }
          : { ...node };

    if (nodeIsTable) {
      return { nodes: [nextNode, ...hoisted], hoisted: [] };
    }

    return insideTable ? { nodes: [nextNode], hoisted } : { nodes: [nextNode, ...hoisted], hoisted: [] };
  }

  const visited = visit(content, false);
  return {
    content: visited.nodes[0] ?? content,
    changed
  };
}
