import type { JSONContent } from "@tiptap/react";

import { buildAiEditHtml } from "./markdown";
import type { AiEditImage, AiEditWidget } from "./types";
import { escapeHtml, getImagePathFromSource, isImageSource } from "./utils";
import { withShareToken } from "./share-url";

function toRepoImageNode(image: AiEditImage) {
  return `<figure data-repo-image src="${escapeHtml(withShareToken(image.src, null))}" alt="${escapeHtml(image.alt)}" caption="${escapeHtml(
    image.caption ?? ""
  )}" path="${escapeHtml(image.path ?? image.src)}"></figure>`;
}

function toWidgetNode(widget: AiEditWidget, documentId: string) {
  return `<div data-embedded-widget widgetId="${escapeHtml(widget.id)}" documentId="${escapeHtml(
    documentId
  )}" label="${escapeHtml(widget.label)}" buildCmd="${escapeHtml(
    widget.buildCmd
  )}" embedSource="${escapeHtml(widget.embedSource)}" src="${escapeHtml(withShareToken(widget.src, null))}" collapsed="true"></div>`;
}

// An embeddedWidget already present in the current document, keyed for resolving
// widget://<widgetId> placeholders that an agent echoed from a selection.
export type ExistingWidget = {
  widgetId: string;
  label: string;
  buildCmd: string;
  embedSource: string;
  src: string;
};

const WIDGET_PLACEHOLDER_SCHEME = "widget://";

// "widget: Foo" / "Interactive widget: Foo" / "Foo" -> "Foo".
function stripWidgetLabelPrefix(alt: string): string {
  const trimmed = alt.trim();
  const match = trimmed.match(/^(?:interactive\s+)?widget:\s*(.*)$/i);
  return (match ? match[1] : trimmed).trim();
}

// True when the edit run carries content worth applying to the document: some
// replacement prose, OR at least one image/widget. Used by the apply path so an
// empty replacement that only produced widgets/images is NOT dropped.
export function aiEditRunHasApplicableContent(input: {
  replacementText?: string | null;
  images?: unknown[] | null;
  widgets?: unknown[] | null;
}): boolean {
  const hasText = typeof input.replacementText === "string" && input.replacementText.trim().length > 0;
  const hasImages = Array.isArray(input.images) && input.images.length > 0;
  const hasWidgets = Array.isArray(input.widgets) && input.widgets.length > 0;
  return hasText || hasImages || hasWidgets;
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
    : `/api/documents/${input.documentId}/repo-files?path=${encodeURIComponent(path)}`;

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
  // Widgets already present in the current document, so widget://<widgetId>
  // placeholders an agent echoed from a selection resolve back to the SAME node
  // instead of being pasted as literal link/metadata text.
  existingWidgets?: ExistingWidget[];
  // When false, images that aren't referenced inline in replacementText are NOT
  // appended at the end. Agent suggestions set this so the run's images don't get
  // duplicated onto every suggestion — each suggestion renders only what it cites.
  appendUnusedImages?: boolean;
}) {
  const appendUnusedImages = input.appendUnusedImages ?? true;
  const imagesByPath = new Map<string, AiEditImage>();
  input.images.forEach((image) => {
    if (image.path) {
      imagesByPath.set(getImagePathFromSource(image.path), image);
    }
    imagesByPath.set(getImagePathFromSource(image.src), image);
  });

  // Widget resolution state. Newly-submitted array widgets are consumed as they
  // are placed inline; whatever is left over is appended at the end (back-compat).
  const submittedWidgets = input.widgets ?? [];
  const consumedWidgetIds = new Set<string>();
  const existingById = new Map<string, ExistingWidget>();
  (input.existingWidgets ?? []).forEach((widget) => {
    if (widget.widgetId) existingById.set(widget.widgetId, widget);
  });
  const existingWidgetNode = (widget: ExistingWidget) =>
    toWidgetNode(
      { id: widget.widgetId, label: widget.label, buildCmd: widget.buildCmd, embedSource: widget.embedSource, src: widget.src },
      input.documentId
    );

  // Pick an unconsumed freshly-submitted widget: prefer a label match, else the
  // next one in submission order.
  function takeNewWidget(label: string): string | null {
    const wanted = label.trim();
    const byLabel = wanted
      ? submittedWidgets.find((widget) => widget.label.trim() === wanted && !consumedWidgetIds.has(widget.id))
      : undefined;
    const widget = byLabel ?? submittedWidgets.find((w) => !consumedWidgetIds.has(w.id));
    if (!widget) return null;
    consumedWidgetIds.add(widget.id);
    return toWidgetNode(widget, input.documentId);
  }

  // Resolve a widget://<ref> placeholder. "new"/"new/<label>" -> a submitted
  // array widget; otherwise <ref> is a widgetId matched against existing document
  // widgets first, then any submitted widget by id. Returns HTML or null.
  function resolveWidgetPlaceholder(ref: string, altLabel: string): string | null {
    const trimmedRef = ref.trim();
    if (trimmedRef === "new" || /^new[/:]/.test(trimmedRef)) {
      const suffix = trimmedRef.slice(3).replace(/^[/:]/, "");
      let wantedLabel = altLabel;
      if (suffix) {
        try {
          wantedLabel = decodeURIComponent(suffix);
        } catch {
          wantedLabel = suffix;
        }
      }
      return takeNewWidget(wantedLabel);
    }
    const existing = existingById.get(trimmedRef);
    if (existing) return existingWidgetNode(existing);
    const submitted = submittedWidgets.find((widget) => widget.id === trimmedRef && !consumedWidgetIds.has(widget.id));
    if (submitted) {
      consumedWidgetIds.add(submitted.id);
      return toWidgetNode(submitted, input.documentId);
    }
    return null;
  }

  // Heal a legacy [Interactive widget: <label>](src) link into a widget node,
  // matching a submitted widget (consuming it) or an existing document widget by
  // label. Returns HTML or null when nothing matches (link is left as-is).
  function resolveLegacyWidgetLink(label: string): string | null {
    const wanted = label.trim();
    const submitted = submittedWidgets.find((widget) => widget.label.trim() === wanted && !consumedWidgetIds.has(widget.id));
    if (submitted) {
      consumedWidgetIds.add(submitted.id);
      return toWidgetNode(submitted, input.documentId);
    }
    const existing = (input.existingWidgets ?? []).find((widget) => widget.label.trim() === wanted);
    if (existing) return existingWidgetNode(existing);
    return null;
  }

  const usedImagePaths = new Set<string>();
  const content: string[] = [];
  const text = input.replacementText;
  const markdownImagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(?<!\!)\[([^\]]+)\]\(([^)\s]+)\)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  const flushBefore = (index: number) => {
    const before = text.slice(cursor, index).trim();
    if (before) content.push(buildAiEditHtml(before, []));
  };

  while ((match = markdownImagePattern.exec(text)) !== null) {
    const isImageSyntax = match[1] !== undefined || match[2] !== undefined;
    const alt = match[1] ?? match[3] ?? "";
    const src = match[2] ?? match[4] ?? "";
    const matchEnd = match.index + match[0].length;

    // Widget placeholder: ![widget: <label>](widget://<ref>)
    if (isImageSyntax && src.trim().startsWith(WIDGET_PLACEHOLDER_SCHEME)) {
      const ref = src.trim().slice(WIDGET_PLACEHOLDER_SCHEME.length);
      const node = resolveWidgetPlaceholder(ref, stripWidgetLabelPrefix(alt));
      flushBefore(match.index);
      if (node) content.push(node); // unresolved placeholders are dropped, not printed literally
      cursor = matchEnd;
      continue;
    }

    // Legacy widget link: [Interactive widget: <label>](src) [ <!-- build: ... --> ]
    if (!isImageSyntax && /^interactive\s+widget:/i.test(alt.trim())) {
      const node = resolveLegacyWidgetLink(stripWidgetLabelPrefix(alt));
      if (node) {
        flushBefore(match.index);
        content.push(node);
        // Swallow a trailing build comment so it doesn't render as literal text.
        const commentMatch = text.slice(matchEnd).match(/^\s*<!--\s*build:[\s\S]*?-->/);
        cursor = matchEnd + (commentMatch ? commentMatch[0].length : 0);
      }
      // If unmatched, leave the link untouched (submission validator rejects
      // orphan legacy metadata; this is only a best-effort heal).
      continue;
    }

    // Image (or an ordinary link that points at an image file).
    const image = resolveMarkdownImage({
      src,
      alt,
      imagesByPath,
      documentId: input.documentId,
      shareToken: null
    });
    if (!image) {
      continue;
    }
    flushBefore(match.index);
    content.push(toRepoImageNode(image));
    usedImagePaths.add(getImagePathFromSource(image.path ?? image.src));
    cursor = matchEnd;
  }

  const after = text.slice(cursor).trim();
  if (after) {
    content.push(buildAiEditHtml(after, input.sourceLinks));
  } else if (input.sourceLinks.length > 0) {
    content.push(buildAiEditHtml("", input.sourceLinks));
  }

  if (appendUnusedImages) {
    input.images
      .filter((image) => !usedImagePaths.has(getImagePathFromSource(image.path ?? image.src)))
      .forEach((image) => {
        content.push(toRepoImageNode(image));
      });
  }

  // Any submitted widget NOT placed inline via a placeholder is appended at the
  // end (back-compat with agents that only fill the widgets array).
  submittedWidgets
    .filter((widget) => !consumedWidgetIds.has(widget.id))
    .forEach((widget) => {
      content.push(toWidgetNode(widget, input.documentId));
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
