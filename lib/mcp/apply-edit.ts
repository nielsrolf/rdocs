import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import type { JSONContent } from "@tiptap/react";

import { getCollaborationVersion, submitCollaborationSteps } from "@/lib/collaboration";
import { parseDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import { createDocumentEditorSchema } from "@/lib/document-editor-schema";
import { markdownToDocNodes } from "@/lib/mcp/markdown-doc";

const schema = createDocumentEditorSchema();

export type MarkdownEditMode = "replace" | "append" | "replace_all";

export class McpEditError extends Error {}

// Markdown-shaped placeholder text for atom block nodes, mirroring what
// getDocumentMarkdown emits for them, so find_text copied from read_document
// can match (and therefore delete/move) widgets, images and attachments.
function atomPlaceholderText(node: ProseMirrorNode): string | null {
  const attrs = node.attrs as Record<string, unknown>;
  const str = (key: string) => (typeof attrs[key] === "string" ? (attrs[key] as string) : "");
  switch (node.type.name) {
    case "embeddedWidget": {
      const label = str("label") || "Interactive widget";
      return `![widget: ${label}](widget://${str("widgetId") || "new"})`;
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
      return src ? `![${str("alt")}](${src})` : null;
    }
    case "attachmentChip":
      return `[Attachment: ${str("fileName") || "Attachment"}](${str("workspacePath")})`;
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
      const placeholder = atomPlaceholderText(node);
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

function fragmentFromNodes(nodes: JSONContent[]): Fragment {
  return Fragment.fromArray(nodes.map((node) => schema.nodeFromJSON(node)));
}

function buildEditSteps(input: {
  doc: ProseMirrorNode;
  mode: MarkdownEditMode;
  findText?: string;
  nodes: JSONContent[];
}) {
  const tr = new Transform(input.doc);
  const fragment = fragmentFromNodes(input.nodes);

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
  const $from = input.doc.resolve(from);
  const $to = input.doc.resolve(to);

  // Empty replacement deletes the matched range (e.g. removing a widget
  // placeholder or a whole block). deleteRange expands to full blocks so no
  // empty husk paragraphs/list items are left behind.
  if (input.nodes.length === 0) {
    tr.deleteRange(from, to);
    return tr;
  }

  // A single-paragraph replacement of a range inside one textblock is applied
  // inline, so replacing a phrase doesn't split its paragraph.
  const singleParagraph =
    input.nodes.length === 1 && input.nodes[0].type === "paragraph" ? input.nodes[0] : null;
  if (singleParagraph && $from.sameParent($to) && $from.parent.isTextblock) {
    tr.replaceWith(from, to, fragmentFromNodes(singleParagraph.content ?? []));
    return tr;
  }

  // Replacing list item(s) with a list: swap whole items at the matched list's
  // level so the replacement's own structure decides nesting. Without this,
  // replaceRange "fits" the new list INSIDE the matched item, so a new bullet
  // always became a nested child and items could never be de-nested.
  const listTypeNames = new Set(["bulletList", "orderedList", "taskList"]);
  const singleList =
    input.nodes.length === 1 && listTypeNames.has(input.nodes[0].type ?? "") ? input.nodes[0] : null;
  const coversWholeBlocks =
    $from.parent.isTextblock && $to.parent.isTextblock && from === $from.start() && to === $to.end();
  if (singleList && coversWholeBlocks) {
    const range = $from.blockRange($to, (node) => listTypeNames.has(node.type.name));
    if (range) {
      const newList = schema.nodeFromJSON(singleList);
      if (range.startIndex === 0 && range.endIndex === range.parent.childCount) {
        // The match covers the whole list — replace the list node itself.
        tr.replaceWith(range.$from.before(range.depth), range.$from.after(range.depth), newList);
        return tr;
      }
      if (range.parent.canReplace(range.startIndex, range.endIndex, newList.content)) {
        // Replace just the matched items with the new list's items (siblings).
        tr.replaceWith(range.start, range.end, newList.content);
        return tr;
      }
    }
  }

  tr.replaceRange(from, to, new Slice(fragment, 0, 0));
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
        })
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
