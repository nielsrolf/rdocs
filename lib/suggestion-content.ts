// Framework-free helpers for tracked-change "suggestions". Shared by the client
// editor module (components/document-workspace/suggestions.ts), the server
// collaboration guard (lib/collaboration.ts), and the agent-side anchor
// validation. Operates on ProseMirror document JSON only — NO @tiptap imports —
// so it is safe to import from the standalone agent runtime and from server
// routes alike.
//
// A suggestion is represented inside the document content as:
//   - inline text: a `suggestedInsertion` / `suggestedDeletion` MARK carrying
//     { suggestionId, authorId, authorLabel, createdAt };
//   - block atoms (repoImage / embeddedWidget / image / attachmentChip), which
//     cannot hold inline marks: a `suggestionInsertRecords` / `suggestionDeleteRecords`
//     node ATTRIBUTE holding an array of those same record objects.

export const SUGGESTED_INSERTION_MARK = "suggestedInsertion";
export const SUGGESTED_DELETION_MARK = "suggestedDeletion";
export const SUGGESTION_INSERT_RECORDS_ATTR = "suggestionInsertRecords";
export const SUGGESTION_DELETE_RECORDS_ATTR = "suggestionDeleteRecords";

// Annotation layers that, like suggestions, do NOT count as committed content:
// comment anchors and the transient AI-edit selection ids. A comment-access user
// is allowed to add/remove these (e.g. anchoring a comment), so the committed-view
// guard strips them before comparing.
const COMMENT_ANCHOR_MARK = "commentAnchor";
const ANNOTATION_ATTRS = ["commentThreadIds", "aiEditSelectionIds"];

export type SuggestionRecord = {
  suggestionId: string;
  authorId: string | null;
  authorLabel: string | null;
  createdAt: string | null;
};

type JsonNode = {
  type?: string;
  text?: string;
  marks?: Array<{ type?: unknown; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
  content?: unknown[];
};

function markType(mark: unknown): string | null {
  if (!mark || typeof mark !== "object") return null;
  const type = (mark as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

function hasMark(node: JsonNode, name: string): boolean {
  return Array.isArray(node.marks) && node.marks.some((mark) => markType(mark) === name);
}

function recordArray(value: unknown): SuggestionRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is SuggestionRecord =>
      Boolean(entry) && typeof entry === "object" && typeof (entry as { suggestionId?: unknown }).suggestionId === "string"
  );
}

// Adjacent text nodes that differ only in text must be merged so that the
// committed-view comparison (see computeCommittedContent) is canonical: dropping
// an inserted run can leave two formerly-separate text nodes side by side that
// in the un-suggested document were a single node.
function mergeAdjacentTextNodes(nodes: unknown[]): unknown[] {
  const merged: unknown[] = [];
  for (const node of nodes) {
    const previous = merged[merged.length - 1];
    if (canMergeTextNodes(previous, node)) {
      (previous as { text: string }).text += (node as { text: string }).text;
      continue;
    }
    merged.push(node);
  }
  return merged;
}

function isTextNode(node: unknown): node is { type: "text"; text: string } {
  return (
    Boolean(node) &&
    typeof node === "object" &&
    (node as { type?: unknown }).type === "text" &&
    typeof (node as { text?: unknown }).text === "string"
  );
}

function canMergeTextNodes(left: unknown, right: unknown): boolean {
  if (!isTextNode(left) || !isTextNode(right)) return false;
  return JSON.stringify({ ...left, text: undefined }) === JSON.stringify({ ...right, text: undefined });
}

function stripMarks(node: JsonNode, names: Set<string>): JsonNode {
  if (!Array.isArray(node.marks)) return node;
  const marks = node.marks.filter((mark) => {
    const type = markType(mark);
    return !type || !names.has(type);
  });
  const next: JsonNode = { ...node };
  if (marks.length > 0) {
    next.marks = marks;
  } else {
    delete next.marks;
  }
  return next;
}

function clearRecordAttr(node: JsonNode, attr: string): JsonNode {
  if (!node.attrs || !(attr in node.attrs)) return node;
  const attrs = { ...node.attrs };
  attrs[attr] = [];
  return { ...node, attrs };
}

// Removes annotation attributes (comment thread ids, AI-edit selection ids) so two
// docs differing only by an annotation compare equal in the committed view.
function stripAnnotationAttrs(node: JsonNode): JsonNode {
  if (!node.attrs) return node;
  let changed = false;
  const attrs = { ...node.attrs };
  for (const key of ANNOTATION_ATTRS) {
    if (key in attrs) {
      delete attrs[key];
      changed = true;
    }
  }
  return changed ? { ...node, attrs } : node;
}

// Reject-all transform: returns the document content as it would look if every
// suggestion were rejected (insertions dropped, deletions kept as committed
// text). This is the "committed view" — the content a COMMENT-permission user is
// forbidden from changing, and the basis for accept/reject parity tests.
//
// `reject: false` produces the accept-all view instead (insertions committed,
// deletions removed), used to test round-trips.
export function computeCommittedContent(content: unknown, options: { reject?: boolean } = {}): unknown {
  const reject = options.reject ?? true;
  return transformNode(content, reject);
}

function transformNode(input: unknown, reject: boolean): unknown {
  if (Array.isArray(input)) {
    const transformed: unknown[] = [];
    for (const child of input) {
      const next = transformNode(child, reject);
      if (next !== null) transformed.push(next);
    }
    return mergeAdjacentTextNodes(transformed);
  }

  if (!input || typeof input !== "object") return input;
  const node = input as JsonNode;

  // Inline text — or any other inline node that carries marks, e.g. a hardBreak
  // that fell inside a commented range (addMark marks all inline content, not
  // just text). Comment-anchor marks are always stripped (annotation, not
  // content) regardless of accept/reject; suggestion marks follow accept/reject.
  if (node.type === "text" || (Array.isArray(node.marks) && node.marks.length > 0)) {
    const inserted = hasMark(node, SUGGESTED_INSERTION_MARK);
    const deleted = hasMark(node, SUGGESTED_DELETION_MARK);
    if (inserted) {
      // Insertion: dropped on reject, committed (mark stripped) on accept.
      return reject ? null : stripMarks(node, new Set([SUGGESTED_INSERTION_MARK, COMMENT_ANCHOR_MARK]));
    }
    if (deleted) {
      // Deletion: kept (mark stripped) on reject, dropped on accept.
      return reject ? stripMarks(node, new Set([SUGGESTED_DELETION_MARK, COMMENT_ANCHOR_MARK])) : null;
    }
    return stripMarks(node, new Set([COMMENT_ANCHOR_MARK]));
  }

  // Block atoms tracked via node attributes.
  const insertRecords = recordArray(node.attrs?.[SUGGESTION_INSERT_RECORDS_ATTR]);
  const deleteRecords = recordArray(node.attrs?.[SUGGESTION_DELETE_RECORDS_ATTR]);
  if (insertRecords.length > 0) {
    return reject ? null : stripAnnotationAttrs(clearRecordAttr(node, SUGGESTION_INSERT_RECORDS_ATTR));
  }
  if (deleteRecords.length > 0) {
    if (!reject) return null;
    return stripAnnotationAttrs(clearRecordAttr(node, SUGGESTION_DELETE_RECORDS_ATTR));
  }

  const stripped = stripAnnotationAttrs(node);
  if (Array.isArray(stripped.content)) {
    return { ...stripped, content: transformNode(stripped.content, reject) as unknown[] };
  }
  return stripped;
}

// Concatenates the raw text of every text node in document order, with NO
// separators between blocks. The client anchor resolver builds the identical
// string (plus an offset→position map) when locating an agent's findText, so the
// server-side uniqueness check and the client-side resolution stay in lockstep.
export function flattenDocumentTextNodes(content: unknown): string {
  let out = "";
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const typed = node as JsonNode;
    if (typed.type === "text" && typeof typed.text === "string") {
      out += typed.text;
      return;
    }
    if (Array.isArray(typed.content)) typed.content.forEach(visit);
  };
  visit(content);
  return out;
}
