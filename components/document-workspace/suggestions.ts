import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import type { MarkType, Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import {
  SUGGESTED_DELETION_MARK,
  SUGGESTED_INSERTION_MARK,
  SUGGESTION_DELETE_RECORDS_ATTR,
  SUGGESTION_INSERT_RECORDS_ATTR,
  type SuggestionRecord
} from "@/lib/suggestion-content";

// ---------------------------------------------------------------------------
// Tracked-change "suggestions" (Google-Docs style).
//
// Insertions and deletions made while suggesting mode is on are recorded in the
// document instead of being committed: inserted inline text carries a
// `suggestedInsertion` mark, deleted inline text is struck with a
// `suggestedDeletion` mark (the text stays until accepted), and whole block
// atoms are tracked via the suggestionInsert/DeleteRecords node attributes.
//
// Both marks ride the prosemirror-collab step pipeline like every other mark, so
// suggestions propagate to all clients and persist with no new storage path.
// Accept/reject produce ordinary steps too.
//
// Modeled on components/document-workspace/ai-edit-selections.ts.
// ---------------------------------------------------------------------------

export type SuggestionAuthor = {
  authorId: string | null;
  authorLabel: string | null;
};

export type SuggestionKind = "insert" | "delete";

export type SuggestionSummary = {
  suggestionId: string;
  kind: SuggestionKind;
  from: number;
  to: number;
  author: SuggestionAuthor;
  createdAt: string | null;
};

const ATOM_NODE_TYPES = new Set(["repoImage", "embeddedWidget", "image", "attachmentChip"]);

function isAtomNode(node: PMNode): boolean {
  return ATOM_NODE_TYPES.has(node.type.name);
}

type SuggestionPluginState = { enabled: boolean; author: SuggestionAuthor };

type SuggestionPluginMeta =
  | { type: "configure"; enabled: boolean; author?: SuggestionAuthor }
  // Marks a transaction the interceptor must ignore: our own appended rewrite,
  // or a remote collab apply (foreign steps already carry their author's marks).
  | { type: "skip" };

export const suggestionPluginKey = new PluginKey<SuggestionPluginState>("suggestions");

let idCounter = 0;
export function createSuggestionId(): string {
  return newSuggestionId();
}
function newSuggestionId(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${(idCounter += 1)}`;
  return `sg-${rand}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// --- Mark attribute plumbing ------------------------------------------------

function dataAttr(attrKey: string, dataName: string) {
  return {
    default: null as string | null,
    parseHTML: (element: HTMLElement) => element.getAttribute(dataName),
    renderHTML: (attributes: Record<string, unknown>) => {
      const value = attributes[attrKey];
      return typeof value === "string" && value ? { [dataName]: value } : {};
    }
  };
}

function suggestionMarkAttributes() {
  return {
    suggestionId: dataAttr("suggestionId", "data-suggestion-id"),
    authorId: dataAttr("authorId", "data-suggestion-author"),
    authorLabel: dataAttr("authorLabel", "data-suggestion-author-label"),
    createdAt: dataAttr("createdAt", "data-suggestion-created")
  };
}

export const SuggestedInsertion = Mark.create({
  name: SUGGESTED_INSERTION_MARK,
  // Inclusive so continued typing at the boundary extends the same suggestion
  // run instead of starting a new one for every keystroke.
  inclusive: true,
  spanning: true,
  addAttributes() {
    return suggestionMarkAttributes();
  },
  parseHTML() {
    return [{ tag: "span[data-suggested-insertion]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-suggested-insertion": "", class: "suggestion-insert" }),
      0
    ];
  }
});

export const SuggestedDeletion = Mark.create({
  name: SUGGESTED_DELETION_MARK,
  inclusive: false,
  spanning: true,
  addAttributes() {
    return suggestionMarkAttributes();
  },
  parseHTML() {
    return [{ tag: "span[data-suggested-deletion]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-suggested-deletion": "", class: "suggestion-delete" }),
      0
    ];
  }
});

// --- Record helpers (inline marks + atom attrs) -----------------------------

function markRecord(mark: { attrs?: Record<string, unknown> }): SuggestionRecord {
  const attrs = mark.attrs ?? {};
  return {
    suggestionId: typeof attrs.suggestionId === "string" ? attrs.suggestionId : "",
    authorId: typeof attrs.authorId === "string" ? attrs.authorId : null,
    authorLabel: typeof attrs.authorLabel === "string" ? attrs.authorLabel : null,
    createdAt: typeof attrs.createdAt === "string" ? attrs.createdAt : null
  };
}

function nodeRecords(node: PMNode, attr: string): SuggestionRecord[] {
  const raw = node.attrs?.[attr];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is SuggestionRecord =>
      Boolean(entry) && typeof entry === "object" && typeof (entry as { suggestionId?: unknown }).suggestionId === "string"
  );
}

function makeRecord(suggestionId: string, author: SuggestionAuthor, createdAt: string): SuggestionRecord {
  return {
    suggestionId,
    authorId: author.authorId,
    authorLabel: author.authorLabel,
    createdAt
  };
}

// --- Collecting suggestions for UI / accept-reject --------------------------

export function collectSuggestionRanges(doc: PMNode): SuggestionSummary[] {
  const byId = new Map<string, SuggestionSummary>();

  const extend = (record: SuggestionRecord, kind: SuggestionKind, from: number, to: number) => {
    if (!record.suggestionId) return;
    // Key by id+kind: a find/replace suggestion shares one id across its deletion
    // and insertion parts, so they must surface as two ranges (the UI groups them
    // back by suggestionId).
    const key = `${record.suggestionId}:${kind}`;
    const existing = byId.get(key);
    if (existing) {
      existing.from = Math.min(existing.from, from);
      existing.to = Math.max(existing.to, to);
      return;
    }
    byId.set(key, {
      suggestionId: record.suggestionId,
      kind,
      from,
      to,
      author: { authorId: record.authorId, authorLabel: record.authorLabel },
      createdAt: record.createdAt
    });
  };

  doc.descendants((node, pos) => {
    if (node.isText) {
      for (const mark of node.marks) {
        if (mark.type.name === SUGGESTED_INSERTION_MARK) {
          extend(markRecord(mark), "insert", pos, pos + node.nodeSize);
        } else if (mark.type.name === SUGGESTED_DELETION_MARK) {
          extend(markRecord(mark), "delete", pos, pos + node.nodeSize);
        }
      }
      return;
    }
    if (ATOM_NODE_TYPES.has(node.type.name)) {
      for (const record of nodeRecords(node, SUGGESTION_INSERT_RECORDS_ATTR)) {
        extend(record, "insert", pos, pos + node.nodeSize);
      }
      for (const record of nodeRecords(node, SUGGESTION_DELETE_RECORDS_ATTR)) {
        extend(record, "delete", pos, pos + node.nodeSize);
      }
    }
  });

  return Array.from(byId.values()).sort((a, b) => a.from - b.from);
}

export function hasPendingSuggestions(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.isText) {
      if (node.marks.some((m) => m.type.name === SUGGESTED_INSERTION_MARK || m.type.name === SUGGESTED_DELETION_MARK)) {
        found = true;
      }
      return;
    }
    if (ATOM_NODE_TYPES.has(node.type.name)) {
      if (
        nodeRecords(node, SUGGESTION_INSERT_RECORDS_ATTR).length > 0 ||
        nodeRecords(node, SUGGESTION_DELETE_RECORDS_ATTR).length > 0
      ) {
        found = true;
      }
    }
    return undefined;
  });
  return found;
}

// --- Insertion interception (appendTransaction) -----------------------------

// Inserted content ranges, expressed in the coordinate space of the document
// AFTER all the given transactions have been applied (i.e. newState.doc).
function collectInsertedRanges(transactions: readonly Transaction[]): Array<{ from: number; to: number }> {
  const maps = transactions.flatMap((tr) => tr.steps.map((step) => step.getMap()));
  const ranges: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < maps.length; i += 1) {
    maps[i].forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (newEnd <= newStart) return;
      let from = newStart;
      let to = newEnd;
      for (let j = i + 1; j < maps.length; j += 1) {
        from = maps[j].map(from, 1);
        to = maps[j].map(to, -1);
      }
      if (to > from) ranges.push({ from, to });
    });
  }
  return ranges;
}

// The suggestion id to attach to freshly-inserted text at `from`: reuse the
// suggestion run immediately before it (so consecutive typing/paste stays one
// suggestion) when authored by the same person, else mint a new id.
function insertionIdBefore(doc: PMNode, from: number, author: SuggestionAuthor): string | null {
  if (from <= 0) return null;
  const $pos = doc.resolve(from);
  for (const mark of $pos.marks()) {
    if (mark.type.name !== SUGGESTED_INSERTION_MARK) continue;
    const record = markRecord(mark);
    if (record.authorId === author.authorId) return record.suggestionId || null;
  }
  return null;
}

function buildInsertionMarkTransaction(
  transactions: readonly Transaction[],
  newState: EditorState,
  author: SuggestionAuthor
): Transaction | null {
  const insertMark = newState.schema.marks[SUGGESTED_INSERTION_MARK];
  if (!insertMark) return null;
  const ranges = collectInsertedRanges(transactions);
  if (ranges.length === 0) return null;

  const tr = newState.tr;
  const createdAt = nowIso();
  let changed = false;

  for (const range of ranges) {
    const docSize = tr.doc.content.size;
    const from = Math.max(0, Math.min(range.from, docSize));
    const to = Math.max(from, Math.min(range.to, docSize));
    if (to <= from) continue;

    let reuseId = insertionIdBefore(tr.doc, from, author);

    tr.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isText) {
        // Text the inclusive mark already covered needs nothing.
        if (node.marks.some((m) => m.type.name === SUGGESTED_INSERTION_MARK)) return;
        const segFrom = Math.max(from, pos);
        const segTo = Math.min(to, pos + node.nodeSize);
        if (segTo <= segFrom) return;
        const suggestionId = reuseId ?? newSuggestionId();
        reuseId = suggestionId;
        tr.addMark(segFrom, segTo, insertMark.create({ ...makeRecord(suggestionId, author, createdAt) }));
        changed = true;
        return;
      }
      if (ATOM_NODE_TYPES.has(node.type.name)) {
        const existing = nodeRecords(node, SUGGESTION_INSERT_RECORDS_ATTR);
        if (existing.length > 0) return;
        const suggestionId = newSuggestionId();
        tr.setNodeAttribute(pos, SUGGESTION_INSERT_RECORDS_ATTR, [makeRecord(suggestionId, author, createdAt)]);
        changed = true;
      }
    });
  }

  if (!changed) return null;
  tr.setMeta(suggestionPluginKey, { type: "skip" } satisfies SuggestionPluginMeta);
  tr.setMeta("addToHistory", false);
  return tr;
}

// --- Plugin -----------------------------------------------------------------

function atomDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!ATOM_NODE_TYPES.has(node.type.name)) return;
    if (nodeRecords(node, SUGGESTION_INSERT_RECORDS_ATTR).length > 0) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "suggestion-insert-atom" }));
    } else if (nodeRecords(node, SUGGESTION_DELETE_RECORDS_ATTR).length > 0) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "suggestion-delete-atom" }));
    }
  });
  return DecorationSet.create(doc, decorations);
}

export function createSuggestionPlugin() {
  return new Plugin<SuggestionPluginState>({
    key: suggestionPluginKey,
    state: {
      init: () => ({ enabled: false, author: { authorId: null, authorLabel: null } }),
      apply: (transaction, previous) => {
        const meta = transaction.getMeta(suggestionPluginKey) as SuggestionPluginMeta | undefined;
        if (meta?.type === "configure") {
          return { enabled: meta.enabled, author: meta.author ?? previous.author };
        }
        return previous;
      }
    },
    appendTransaction(transactions, _oldState, newState) {
      const pluginState = suggestionPluginKey.getState(newState);
      if (!pluginState?.enabled) return null;
      if (!transactions.some((tr) => tr.docChanged)) return null;
      // Ignore our own rewrites and remote collab applies.
      for (const tr of transactions) {
        const meta = tr.getMeta(suggestionPluginKey) as SuggestionPluginMeta | undefined;
        if (meta?.type === "skip") return null;
      }
      return buildInsertionMarkTransaction(transactions, newState, pluginState.author);
    },
    props: {
      decorations(state) {
        return atomDecorations(state.doc);
      }
    }
  });
}

// --- Mode toggle ------------------------------------------------------------

export function setSuggestionMode(state: EditorState, enabled: boolean, author?: SuggestionAuthor): Transaction {
  return state.tr.setMeta(suggestionPluginKey, {
    type: "configure",
    enabled,
    author
  } satisfies SuggestionPluginMeta);
}

export function isSuggestionModeEnabled(state: EditorState): boolean {
  return suggestionPluginKey.getState(state)?.enabled ?? false;
}

// --- Deletion interception --------------------------------------------------

// The range a native Backspace/Delete would remove, or null when the change is
// structural (block join at a boundary) and should fall through to the default
// handler — v1 only tracks inline + atom deletions within a block.
export function resolveDeletionRange(
  state: EditorState,
  direction: "backward" | "forward"
): { from: number; to: number } | null {
  const sel = state.selection;
  // A selected node (e.g. an image clicked directly) — target it whole.
  if (sel instanceof NodeSelection) {
    return { from: sel.from, to: sel.to };
  }
  if (!sel.empty) {
    return { from: sel.from, to: sel.to };
  }
  const $head = sel.$head;
  if (direction === "backward") {
    if ($head.parentOffset === 0) {
      // Block start: if a block atom (image/widget/attachment) directly precedes
      // this block, target it instead of falling through to a structural join.
      const before = $head.before();
      const nodeBefore = before > 0 ? state.doc.resolve(before).nodeBefore : null;
      if (nodeBefore && isAtomNode(nodeBefore)) {
        return { from: before - nodeBefore.nodeSize, to: before };
      }
      return null;
    }
    return { from: $head.pos - 1, to: $head.pos };
  }
  if ($head.parentOffset >= $head.parent.content.size) {
    // Block end: target a block atom that directly follows this block.
    const after = $head.after();
    const nodeAfter = state.doc.resolve(after).nodeAfter;
    if (nodeAfter && isAtomNode(nodeAfter)) {
      return { from: after, to: after + nodeAfter.nodeSize };
    }
    return null;
  }
  return { from: $head.pos, to: $head.pos + 1 };
}

// Converts a deletion into tracked changes: text/atoms the same author already
// suggested-inserted are really removed (withdrawing your own pending insertion);
// everything else is marked suggestedDeletion (kept until accepted).
export function buildDeletionSuggestion(
  state: EditorState,
  range: { from: number; to: number },
  author: SuggestionAuthor,
  direction: "backward" | "forward" = "backward"
): Transaction | null {
  const deleteMark = state.schema.marks[SUGGESTED_DELETION_MARK];
  if (!deleteMark) return null;

  const docSize = state.doc.content.size;
  const from = Math.max(0, Math.min(range.from, docSize));
  const to = Math.max(from, Math.min(range.to, docSize));
  if (to <= from) return null;

  const markSegments: Array<{ from: number; to: number }> = [];
  const realDeletes: Array<{ from: number; to: number }> = [];
  const atomDeleteRecords: Array<{ pos: number; records: SuggestionRecord[] }> = [];
  const createdAt = nowIso();
  const suggestionId = newSuggestionId();

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) {
      const segFrom = Math.max(from, pos);
      const segTo = Math.min(to, pos + node.nodeSize);
      if (segTo <= segFrom) return;
      const ownInsertion = node.marks.find(
        (m) => m.type.name === SUGGESTED_INSERTION_MARK && markRecord(m).authorId === author.authorId
      );
      if (ownInsertion) {
        realDeletes.push({ from: segFrom, to: segTo });
        return;
      }
      // Already struck — leave as-is.
      if (node.marks.some((m) => m.type.name === SUGGESTED_DELETION_MARK)) return;
      markSegments.push({ from: segFrom, to: segTo });
      return;
    }
    if (ATOM_NODE_TYPES.has(node.type.name)) {
      const ownInsert = nodeRecords(node, SUGGESTION_INSERT_RECORDS_ATTR).some(
        (r) => r.authorId === author.authorId
      );
      if (ownInsert) {
        realDeletes.push({ from: pos, to: pos + node.nodeSize });
        return;
      }
      if (nodeRecords(node, SUGGESTION_DELETE_RECORDS_ATTR).length > 0) return;
      atomDeleteRecords.push({ pos, records: [makeRecord(suggestionId, author, createdAt)] });
    }
  });

  if (markSegments.length === 0 && realDeletes.length === 0 && atomDeleteRecords.length === 0) {
    return null;
  }

  const tr = state.tr;
  // Position-preserving edits first.
  for (const seg of markSegments) {
    tr.addMark(seg.from, seg.to, deleteMark.create({ ...makeRecord(suggestionId, author, createdAt) }));
  }
  for (const atom of atomDeleteRecords) {
    tr.setNodeAttribute(atom.pos, SUGGESTION_DELETE_RECORDS_ATTR, atom.records);
  }
  // Real deletions last, high → low so earlier offsets stay valid.
  for (const del of [...realDeletes].sort((a, b) => b.from - a.from)) {
    tr.delete(del.from, del.to);
  }

  // Move the cursor past the affected range so a repeat keystroke targets the
  // neighbouring content rather than re-hitting the struck text.
  const anchor = direction === "backward" ? tr.mapping.map(from, -1) : tr.mapping.map(to, 1);
  const resolved = Math.max(0, Math.min(anchor, tr.doc.content.size));
  tr.setSelection(TextSelection.near(tr.doc.resolve(resolved)));
  tr.setMeta(suggestionPluginKey, { type: "skip" } satisfies SuggestionPluginMeta);
  return tr;
}

// Applies suggestion marks to already-present content: strikes `deletion` and/or
// flags `insertion` ranges with the SAME record (so one accept handles a
// replacement). Used by the agent-suggestion apply path, which inserts rich
// content first (skip-tagged) and then marks it here. Tagged skip so the
// interceptor doesn't re-mark.
export function markExplicitSuggestion(
  state: EditorState,
  opts: {
    deletion?: { from: number; to: number };
    insertion?: { from: number; to: number };
    record: SuggestionRecord;
  }
): Transaction | null {
  const insMark = state.schema.marks[SUGGESTED_INSERTION_MARK];
  const delMark = state.schema.marks[SUGGESTED_DELETION_MARK];
  if (!insMark || !delMark) return null;
  const tr = state.tr;
  const docSize = state.doc.content.size;

  const apply = (range: { from: number; to: number }, kind: SuggestionKind) => {
    const from = Math.max(0, Math.min(range.from, docSize));
    const to = Math.max(from, Math.min(range.to, docSize));
    if (to <= from) return;
    const mark = (kind === "insert" ? insMark : delMark).create({ ...opts.record });
    const attr = attrForKind(kind);
    tr.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isText) {
        const segFrom = Math.max(from, pos);
        const segTo = Math.min(to, pos + node.nodeSize);
        if (segTo > segFrom) tr.addMark(segFrom, segTo, mark);
        return;
      }
      if (isAtomNode(node)) {
        tr.setNodeAttribute(pos, attr, [opts.record]);
      }
    });
  };

  if (opts.deletion) apply(opts.deletion, "delete");
  if (opts.insertion) apply(opts.insertion, "insert");
  if (!tr.docChanged) return null;
  tr.setMeta(suggestionPluginKey, { type: "skip" } satisfies SuggestionPluginMeta);
  return tr;
}

function attrForKind(kind: SuggestionKind): string {
  return kind === "insert" ? SUGGESTION_INSERT_RECORDS_ATTR : SUGGESTION_DELETE_RECORDS_ATTR;
}

// --- Accept / reject --------------------------------------------------------

type AccumulatedTargets = {
  removeMark: Array<{ from: number; to: number; type: MarkType }>;
  deleteRanges: Array<{ from: number; to: number }>;
  clearAtomAttr: Array<{ pos: number; attr: string; records: SuggestionRecord[] }>;
};

function collectTargets(
  state: EditorState,
  predicate: (suggestionId: string) => boolean,
  resolution: "accept" | "reject"
): AccumulatedTargets {
  const targets: AccumulatedTargets = { removeMark: [], deleteRanges: [], clearAtomAttr: [] };
  const insertMark = state.schema.marks[SUGGESTED_INSERTION_MARK];
  const deleteMark = state.schema.marks[SUGGESTED_DELETION_MARK];

  state.doc.descendants((node, pos) => {
    if (node.isText) {
      const insertion = node.marks.find((m) => m.type.name === SUGGESTED_INSERTION_MARK);
      const deletion = node.marks.find((m) => m.type.name === SUGGESTED_DELETION_MARK);
      if (insertion && predicate(markRecord(insertion).suggestionId)) {
        // accept-insert keeps text (drop mark); reject-insert removes text.
        if (resolution === "accept") targets.removeMark.push({ from: pos, to: pos + node.nodeSize, type: insertMark });
        else targets.deleteRanges.push({ from: pos, to: pos + node.nodeSize });
      }
      if (deletion && predicate(markRecord(deletion).suggestionId)) {
        // accept-delete removes text; reject-delete keeps text (drop mark).
        if (resolution === "accept") targets.deleteRanges.push({ from: pos, to: pos + node.nodeSize });
        else targets.removeMark.push({ from: pos, to: pos + node.nodeSize, type: deleteMark });
      }
      return;
    }
    if (!ATOM_NODE_TYPES.has(node.type.name)) return;

    const inserts = nodeRecords(node, SUGGESTION_INSERT_RECORDS_ATTR);
    const matchedInsert = inserts.some((r) => predicate(r.suggestionId));
    if (matchedInsert) {
      if (resolution === "accept") {
        targets.clearAtomAttr.push({
          pos,
          attr: SUGGESTION_INSERT_RECORDS_ATTR,
          records: inserts.filter((r) => !predicate(r.suggestionId))
        });
      } else {
        targets.deleteRanges.push({ from: pos, to: pos + node.nodeSize });
      }
      return;
    }
    const deletes = nodeRecords(node, SUGGESTION_DELETE_RECORDS_ATTR);
    const matchedDelete = deletes.some((r) => predicate(r.suggestionId));
    if (matchedDelete) {
      if (resolution === "accept") {
        targets.deleteRanges.push({ from: pos, to: pos + node.nodeSize });
      } else {
        targets.clearAtomAttr.push({
          pos,
          attr: SUGGESTION_DELETE_RECORDS_ATTR,
          records: deletes.filter((r) => !predicate(r.suggestionId))
        });
      }
    }
  });

  return targets;
}

function applyTargets(state: EditorState, targets: AccumulatedTargets): Transaction | null {
  if (targets.removeMark.length === 0 && targets.deleteRanges.length === 0 && targets.clearAtomAttr.length === 0) {
    return null;
  }
  const tr = state.tr;
  // Mark removals and attr clears do not change positions; do them first.
  for (const target of targets.removeMark) {
    tr.removeMark(target.from, target.to, target.type);
  }
  for (const target of targets.clearAtomAttr) {
    tr.setNodeAttribute(target.pos, target.attr, target.records);
  }
  // Deletions high → low to keep earlier offsets valid.
  for (const range of [...targets.deleteRanges].sort((a, b) => b.from - a.from)) {
    tr.delete(range.from, range.to);
  }
  tr.setMeta(suggestionPluginKey, { type: "skip" } satisfies SuggestionPluginMeta);
  return tr;
}

export function acceptSuggestion(state: EditorState, suggestionId: string): Transaction | null {
  return applyTargets(state, collectTargets(state, (id) => id === suggestionId, "accept"));
}

export function rejectSuggestion(state: EditorState, suggestionId: string): Transaction | null {
  return applyTargets(state, collectTargets(state, (id) => id === suggestionId, "reject"));
}

export function acceptAllSuggestions(state: EditorState): Transaction | null {
  return applyTargets(state, collectTargets(state, () => true, "accept"));
}

export function rejectAllSuggestions(state: EditorState): Transaction | null {
  return applyTargets(state, collectTargets(state, () => true, "reject"));
}

// --- Extension --------------------------------------------------------------

export const Suggestions = Extension.create({
  name: "suggestions",

  addExtensions() {
    return [SuggestedInsertion, SuggestedDeletion];
  },

  addProseMirrorPlugins() {
    return [createSuggestionPlugin()];
  },

  addKeyboardShortcuts() {
    const handleDeletion = (direction: "backward" | "forward") => () => {
      const { editor } = this;
      if (!isSuggestionModeEnabled(editor.state)) return false;
      const range = resolveDeletionRange(editor.state, direction);
      if (!range) return false;
      const author = suggestionPluginKey.getState(editor.state)?.author ?? {
        authorId: null,
        authorLabel: null
      };
      const tr = buildDeletionSuggestion(editor.state, range, author, direction);
      if (!tr) return false;
      editor.view.dispatch(tr);
      return true;
    };
    return {
      Backspace: handleDeletion("backward"),
      Delete: handleDeletion("forward")
    };
  }
});
