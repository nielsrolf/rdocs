import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import type { JSONContent } from "@tiptap/react";

import { getCollaborationVersion, submitCollaborationSteps } from "@/lib/collaboration";
import {
  collectPastedImages,
  isPastedImageSrc,
  parseDocumentContent,
  pastedImagePlaceholder,
  tabMarker
} from "@/lib/content";
import { db } from "@/lib/db";
import { createDocumentEditorSchema } from "@/lib/document-editor-schema";
import { markdownToDocNodes } from "@/lib/mcp/markdown-doc";
import { replaceRangeWithBlocks } from "@/lib/structured-replace";

const schema = createDocumentEditorSchema();

export type MarkdownEditMode = "replace" | "append" | "replace_all";

// Pasted images of the CURRENT document content, so echoed pasted-image://N
// placeholders resolve to the original pixels. Numbering matches read_document;
// a concurrent edit that reorders images between read and write is accepted as
// the same race any find_text anchor already has.
async function loadPastedImages(documentId: string) {
  const document = await db.document.findUnique({ where: { id: documentId }, select: { content: true } });
  if (!document) return [];
  return collectPastedImages(parseDocumentContent(document.content)).map((image) => ({
    index: image.index,
    src: image.src,
    alt: image.alt,
    caption: image.caption
  }));
}

export class McpEditError extends Error {}

// Markdown-shaped placeholder text for atom block nodes, mirroring what
// getDocumentMarkdown emits for them, so find_text copied from read_document
// can match (and therefore delete/move) widgets, images and attachments.
function atomPlaceholderText(node: ProseMirrorNode, counters: { pastedImages: number }): string | null {
  const attrs = node.attrs as Record<string, unknown>;
  const str = (key: string) => (typeof attrs[key] === "string" ? (attrs[key] as string) : "");
  switch (node.type.name) {
    case "embeddedWidget": {
      const label = str("label") || "Interactive widget";
      const expanded = attrs.collapsed === false ? ' "expanded"' : "";
      return `![widget: ${label}](widget://${str("widgetId") || "new"}${expanded})`;
    }
    case "repoImage": {
      const path = str("path") || str("src");
      if (!path) return null;
      const caption = str("caption");
      const title = caption ? ` "${caption.replace(/"/g, '\\"')}"` : "";
      return `![${str("alt")}](${path}${title})`;
    }
    case "image": {
      const src = str("src");
      if (isPastedImageSrc(src)) {
        // Same numbering as getDocumentMarkdown's pasted-image://N placeholders.
        counters.pastedImages += 1;
        return pastedImagePlaceholder({ index: counters.pastedImages, alt: str("alt"), caption: str("caption") || null });
      }
      return src ? `![${str("alt")}](${src})` : null;
    }
    case "attachmentChip":
      return `[Attachment: ${str("fileName") || "Attachment"}](${str("workspacePath")})`;
    case "tabBreak":
      return tabMarker(str("title"));
    default:
      return null;
  }
}

// Concatenated document text with a char→ProseMirror-position map. Block
// boundaries contribute a "\n" (mapped to the block's end boundary) so matches
// can span blocks but never silently glue two paragraphs into one word.
// Atom block nodes (widgets, images, attachments) contribute their markdown
// placeholder, every char mapped to the node position so a match on the
// placeholder resolves to exactly the atom node's [pos, pos+1) range.
function buildTextIndex(doc: ProseMirrorNode) {
  let text = "";
  const positions: number[] = [];
  const counters = { pastedImages: 0 };
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i += 1) {
        text += node.text[i];
        positions.push(pos + i);
      }
      return true;
    }
    if (node.isBlock && node.isTextblock && text.length > 0 && !text.endsWith("\n")) {
      text += "\n";
      positions.push(pos);
    }
    if (node.isBlock && node.isAtom) {
      const placeholder = atomPlaceholderText(node, counters);
      if (placeholder) {
        if (text.length > 0 && !text.endsWith("\n")) {
          text += "\n";
          positions.push(pos);
        }
        for (const char of placeholder) {
          text += char;
          positions.push(pos);
        }
        text += "\n";
        positions.push(pos);
      }
      return false;
    }
    return true;
  });
  return { text, positions };
}

// find_text arrives copied from read_document's MARKDOWN, but the text index is
// plain document text. Strip per-line block syntax (list markers, task
// checkboxes, heading hashes, blockquote arrows) and undo the serializer's
// backslash-escaping so markdown-shaped needles can still match.
function stripMarkdownSyntax(value: string): string {
  return value
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(?:>\s+)*/, "")
        .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
        .replace(/^\[[ xX]\]\s+/, "")
        .replace(/^#{1,6}\s+/, "")
    )
    // read_document closes each tab with </tab>; it is not part of the document.
    .filter((line) => !/^\s*<\/tab>\s*$/.test(line))
    .join("\n")
    .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1");
}

// Find `findText` in the doc. Tries an exact match on the extracted text first,
// then a whitespace-normalized match (any whitespace run matches any other).
// Requires exactly one occurrence; returns [from, to) ProseMirror positions.
export function findTextRange(doc: ProseMirrorNode, findText: string): { from: number; to: number } {
  const needle = findText.trim();
  if (!needle) {
    throw new McpEditError("find_text must not be empty.");
  }
  const { text, positions } = buildTextIndex(doc);

  const matchesOf = (haystack: string, target: string) => {
    const found: number[] = [];
    let index = haystack.indexOf(target);
    while (index !== -1) {
      found.push(index);
      index = haystack.indexOf(target, index + 1);
    }
    return found;
  };

  let start = -1;
  let end = -1;
  const exact = matchesOf(text, needle);
  if (exact.length === 1) {
    start = exact[0];
    end = start + needle.length;
  } else if (exact.length === 0) {
    // Whitespace-normalized fallback: collapse whitespace runs on both sides,
    // keeping a normalized-index → original-index map for the haystack.
    const normChars: string[] = [];
    const normToOriginal: number[] = [];
    let lastWasSpace = true;
    for (let i = 0; i < text.length; i += 1) {
      const isSpace = /\s/.test(text[i]);
      if (isSpace && lastWasSpace) continue;
      normChars.push(isSpace ? " " : text[i]);
      normToOriginal.push(i);
      lastWasSpace = isSpace;
    }
    const normText = normChars.join("");
    // Two normalized attempts: the raw needle, then a markdown-stripped needle
    // (list markers / heading hashes / escapes removed) so text copied from
    // read_document's markdown can match across paragraph breaks.
    const needleCandidates = [needle.replace(/\s+/g, " ")];
    const stripped = stripMarkdownSyntax(needle).replace(/\s+/g, " ").trim();
    if (stripped && !needleCandidates.includes(stripped)) {
      needleCandidates.push(stripped);
    }
    let matched = false;
    for (const normNeedle of needleCandidates) {
      const normalized = matchesOf(normText, normNeedle);
      if (normalized.length === 1) {
        start = normToOriginal[normalized[0]];
        end = normToOriginal[normalized[0] + normNeedle.length - 1] + 1;
        matched = true;
        break;
      }
      if (normalized.length > 1) {
        throw new McpEditError(
          `find_text matches ${normalized.length} places in the document — include more surrounding context to make it unique.`
        );
      }
    }
    if (!matched) {
      throw new McpEditError(
        "find_text was not found in the document. Re-read the document and copy the text to replace exactly (it must match the document text, not your paraphrase)."
      );
    }
  } else {
    throw new McpEditError(
      `find_text matches ${exact.length} places in the document — include more surrounding context to make it unique.`
    );
  }

  return { from: positions[start], to: positions[end - 1] + 1 };
}

// Exported for tests. Structure-aware splicing lives in lib/structured-replace
// (shared with selection edits and suggestions): a single paragraph replaces
// inline, lists replacing list items become siblings, other blocks never leave an
// empty half of the matched textblock behind, and tab breaks land at the top level.
export function buildEditSteps(input: {
  doc: ProseMirrorNode;
  mode: MarkdownEditMode;
  findText?: string;
  nodes: JSONContent[];
}) {
  const docSchema = input.doc.type.schema;
  const tr = new Transform(input.doc);
  const fragment = Fragment.fromArray(input.nodes.map((node) => docSchema.nodeFromJSON(node)));

  if (input.mode === "append") {
    tr.insert(input.doc.content.size, fragment);
    return tr;
  }

  if (input.mode === "replace_all") {
    tr.replaceWith(0, input.doc.content.size, fragment);
    return tr;
  }

  if (!input.findText) {
    throw new McpEditError("find_text is required for replace edits.");
  }
  const { from, to } = findTextRange(input.doc, input.findText);

  // Renaming a tab: its <tab title="…"> marker replaced by another one keeps the
  // tab (and its id, which links and the active-tab state point at).
  const matched = input.doc.nodeAt(from);
  if (
    matched?.type.name === "tabBreak" &&
    to === from + matched.nodeSize &&
    fragment.childCount === 1 &&
    fragment.child(0).type.name === "tabBreak"
  ) {
    tr.setNodeMarkup(from, undefined, { ...matched.attrs, title: fragment.child(0).attrs.title });
    return tr;
  }

  // Empty replacement deletes the matched range (e.g. removing a widget
  // placeholder or a whole block). deleteRange expands to full blocks so no
  // empty husk paragraphs/list items are left behind.
  if (input.nodes.length === 0) {
    tr.deleteRange(from, to);
    return tr;
  }

  replaceRangeWithBlocks(tr, from, to, fragment);
  return tr;
}

// Apply a markdown edit to a document through the collaboration step pipeline
// (the only sanctioned content-write path — see collab-content-invariant).
// Live clients receive the change over SSE like any collaborator's steps.
// Retries on version races with concurrent editors.
export async function applyMarkdownEdit(input: {
  documentId: string;
  userId: string;
  mode: MarkdownEditMode;
  markdown: string;
  findText?: string;
}): Promise<{ version: number }> {
  const blank = input.markdown.trim() === "";
  if (blank && input.mode === "append") {
    throw new McpEditError("markdown must not be empty.");
  }
  // Blank markdown + replace = delete the matched range. Blank replace_all
  // resets the document to a single empty paragraph.
  const nodes = blank
    ? input.mode === "replace_all"
      ? [{ type: "paragraph" } as JSONContent]
      : []
    : markdownToDocNodes({
        markdown: input.markdown,
        documentId: input.documentId,
        widgetRows: await db.embeddedWidget.findMany({
          where: { documentId: input.documentId },
          select: { id: true, label: true, buildCmd: true, embedSource: true }
        }),
        pastedImages: await loadPastedImages(input.documentId)
      });

  if (!blank && input.mode !== "replace_all" && nodes.length === 0) {
    throw new McpEditError("The markdown produced no content.");
  }

  const clientId = `mcp-${input.userId}-${Date.now().toString(36)}`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const document = await db.document.findUnique({
      where: { id: input.documentId },
      select: { content: true, title: true, updatedAt: true }
    });
    if (!document) {
      throw new McpEditError("Document not found.");
    }

    const version = await getCollaborationVersion(input.documentId, document.content, document.updatedAt);
    const doc = schema.nodeFromJSON(parseDocumentContent(document.content));
    const tr = buildEditSteps({ doc, mode: input.mode, findText: input.findText, nodes });

    if (tr.steps.length === 0) {
      return { version };
    }

    const result = await submitCollaborationSteps({
      documentId: input.documentId,
      rawContent: document.content,
      currentTitle: document.title,
      currentUpdatedAt: document.updatedAt,
      version,
      steps: tr.steps.map((step) => step.toJSON()),
      clientId,
      versionMeta: { forceVersion: true }
    });

    if (result.accepted) {
      return { version: result.version };
    }
    // Stale version (someone else pushed between our read and submit) — re-read
    // and rebuild the steps against the new document.
  }

  throw new McpEditError("The document is being edited concurrently — please retry.");
}
