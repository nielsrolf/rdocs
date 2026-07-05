import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { getAiRunProgressLabel, parseAiRunSelectionId } from "./utils";
import type { ActiveAiRunView } from "./types";

export type AiEditSelectionMetadata = {
  runId?: string | null;
  progress?: string | null;
  source: "local" | "run";
};

type AiEditSelectionEntry = {
  metadata: AiEditSelectionMetadata;
  from: number;
  to: number;
};

type AiEditSelectionState = {
  metadata: Map<string, AiEditSelectionEntry>;
};

type AiEditSelectionMeta =
  | {
      type: "upsertMetadata";
      id: string;
      metadata: AiEditSelectionMetadata;
      from: number;
      to: number;
    }
  | { type: "removeMetadata"; id: string }
  | { type: "reseed"; entries: Array<{ id: string; from: number; to: number }> }
  | {
      type: "syncRuns";
      entries: Array<{ id: string; metadata: AiEditSelectionMetadata }>;
      settledIds?: string[];
    };

export const aiEditSelectionPluginKey = new PluginKey<AiEditSelectionState>("ai-edit-selections");

export const AiEditRange = Mark.create({
  name: "aiEditRange",
  inclusive: false,
  spanning: true,
  addAttributes() {
    // A single text run can be covered by MORE THAN ONE pending AI selection (the
    // user selects overlapping ranges, or two run on adjacent text). A node holds
    // at most one mark of a given type, so the mark carries an ARRAY of selection
    // ids; upsert/remove union and subtract rather than clobbering each other.
    return {
      selectionIds: {
        default: [] as string[],
        parseHTML: (element) => {
          const multi = element.getAttribute("data-ai-edit-ids");
          if (multi) return multi.split(",").map((value) => value.trim()).filter(Boolean);
          const single = element.getAttribute("data-ai-edit-id");
          return single ? [single] : [];
        },
        renderHTML: (attributes) => {
          const ids = Array.isArray(attributes.selectionIds) ? attributes.selectionIds : [];
          if (ids.length === 0) return {};
          return { "data-ai-edit-ids": ids.join(",") };
        }
      }
    };
  },
  parseHTML() {
    return [{ tag: "span[data-ai-edit-ids]" }, { tag: "span[data-ai-edit-id]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  }
});

function markSelectionIds(mark: { attrs?: Record<string, unknown> }): string[] {
  const raw = mark.attrs?.selectionIds;
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string" && !!value) : [];
}

// Block atoms (repoImage / embeddedWidget / image) cannot carry the inline
// aiEditRange mark, so a selection covering one is anchored by the
// aiEditSelectionIds node attribute instead. Both anchors are collected here so
// getAiEditSelectionRange recovers either kind after an editor rebuild.
const ATOM_ANCHOR_NODE_TYPES = new Set(["repoImage", "embeddedWidget", "image"]);

function nodeAiEditSelectionIds(node: { attrs?: Record<string, unknown> }): string[] {
  const raw = node.attrs?.aiEditSelectionIds;
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string" && !!value) : [];
}

export function collectAiEditSelectionRanges(doc: EditorState["doc"]) {
  const ranges = new Map<string, { from: number; to: number }>();

  const extend = (selectionId: string, from: number, to: number) => {
    const current = ranges.get(selectionId);
    ranges.set(selectionId, {
      from: current ? Math.min(current.from, from) : from,
      to: current ? Math.max(current.to, to) : to
    });
  };

  doc.descendants((node, pos) => {
    if (node.isText) {
      for (const mark of node.marks) {
        if (mark.type.name !== "aiEditRange") continue;
        for (const selectionId of markSelectionIds(mark)) {
          extend(selectionId, pos, pos + node.nodeSize);
        }
      }
      return;
    }

    if (ATOM_ANCHOR_NODE_TYPES.has(node.type.name)) {
      for (const selectionId of nodeAiEditSelectionIds(node)) {
        extend(selectionId, pos, pos + node.nodeSize);
      }
    }
  });

  return ranges;
}

// Sets/clears the aiEditSelectionIds anchor on every atom node within [from, to].
// `add === false` removes the id (used by removeAiEditSelection / cleanup).
function setAtomAnchorsInRange(
  tr: Transaction,
  id: string,
  from: number,
  to: number,
  add: boolean
) {
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!ATOM_ANCHOR_NODE_TYPES.has(node.type.name)) return;
    const current = nodeAiEditSelectionIds(node);
    const has = current.includes(id);
    if (add === has) return;
    const next = add ? [...current, id] : current.filter((value) => value !== id);
    tr.setNodeAttribute(pos, "aiEditSelectionIds", next);
  });
}

// Removes an AI-edit selection id from every atom node in the document.
function clearAtomAnchor(tr: Transaction, id: string) {
  tr.doc.descendants((node, pos) => {
    if (!ATOM_ANCHOR_NODE_TYPES.has(node.type.name)) return;
    const current = nodeAiEditSelectionIds(node);
    if (!current.includes(id)) return;
    tr.setNodeAttribute(pos, "aiEditSelectionIds", current.filter((value) => value !== id));
  });
}

function mapMetadata(
  metadata: Map<string, AiEditSelectionEntry>,
  transaction: Transaction
) {
  if (!transaction.docChanged) return metadata;
  const next = new Map<string, AiEditSelectionEntry>();
  const docSize = transaction.doc.content.size;
  for (const [id, entry] of metadata) {
    const from = transaction.mapping.map(entry.from, 1);
    const to = transaction.mapping.map(entry.to, -1);
    if (to > from) {
      next.set(id, { metadata: entry.metadata, from, to });
      continue;
    }
    // The range collapsed — a concurrent edit (typically a remote collaboration
    // step during a long agent run) deleted the selected text. Rather than drop
    // the entry (which loses the anchor entirely and forces "replacement
    // skipped"), retain a zero-width anchor at the surviving position so the AI
    // result can still be inserted there. This is what makes the AI-edit anchor
    // resilient to concurrent edits instead of relying on a deletable mark.
    const point = Math.max(0, Math.min(from, docSize));
    next.set(id, { metadata: entry.metadata, from: point, to: point });
  }
  return next;
}

function applyMeta(
  metadata: Map<string, AiEditSelectionEntry>,
  meta: AiEditSelectionMeta | undefined
) {
  if (!meta) return metadata;

  const next = new Map(metadata);
  if (meta.type === "removeMetadata") {
    next.delete(meta.id);
    return next;
  }
  if (meta.type === "upsertMetadata") {
    next.set(meta.id, {
      metadata: meta.metadata,
      from: meta.from,
      to: meta.to
    });
    return next;
  }
  if (meta.type === "reseed") {
    // Re-pin each entry's range to a freshly-measured document position, keeping
    // whatever metadata it already had. Used after a full-doc setContent remount,
    // whose replace-everything step otherwise collapses every other pending
    // selection's anchor to the document end.
    for (const entry of meta.entries) {
      const current = next.get(entry.id);
      next.set(entry.id, {
        metadata: current?.metadata ?? { runId: null, progress: null, source: "local" },
        from: entry.from,
        to: entry.to
      });
    }
    return next;
  }

  // A settled run (terminal AND its result already applied/claimed) must not
  // keep decorating the document. This is what clears the "Claude is working"
  // shimmer in a tab that did NOT perform the apply itself — its entry was
  // created with source "local" at kickoff and nothing else ever removes it.
  for (const id of meta.settledIds ?? []) {
    next.delete(id);
  }
  const syncedIds = new Set(meta.entries.map((entry) => entry.id));
  for (const [id, value] of next) {
    if (value.metadata.source === "run" && !syncedIds.has(id)) {
      next.delete(id);
    }
  }
  for (const entry of meta.entries) {
    const current = next.get(entry.id);
    if (!current) {
      // No tracked range — skip; we don't know where to place it.
      continue;
    }
    next.set(entry.id, {
      ...current,
      metadata: {
        ...entry.metadata,
        source: current.metadata.source ?? entry.metadata.source
      }
    });
  }
  return next;
}

function buildDecorationSet(state: EditorState) {
  const ranges = new Map<string, { from: number; to: number }>();
  for (const [id, range] of collectAiEditSelectionRanges(state.doc)) {
    ranges.set(id, range);
  }
  const pluginState = aiEditSelectionPluginKey.getState(state);
  if (pluginState) {
    for (const [id, entry] of pluginState.metadata) {
      if (entry.to > entry.from) {
        ranges.set(id, { from: entry.from, to: entry.to });
      }
    }
  }
  const decorations: Decoration[] = [];
  const docSize = state.doc.content.size;
  for (const [selectionId, range] of ranges) {
    const from = Math.max(0, Math.min(range.from, docSize));
    const to = Math.max(from, Math.min(range.to, docSize));
    if (to <= from) continue;
    decorations.push(
      Decoration.inline(
        from,
        to,
        {
          class: "ai-edit-selection-pending",
          "data-ai-edit-id": selectionId
        },
        { key: `ai-edit-selection-${selectionId}` }
      )
    );
  }
  return DecorationSet.create(state.doc, decorations);
}

// The ProseMirror plugin that tracks AI-edit selection ranges through document
// changes. Exported as a factory so it can be exercised on a raw EditorState in
// regression tests (no editor view / DOM required).
export function createAiEditSelectionPlugin() {
  return new Plugin<AiEditSelectionState>({
    key: aiEditSelectionPluginKey,
    state: {
      init: () => ({ metadata: new Map() }),
      apply: (transaction, previous) => {
        const mapped = mapMetadata(previous.metadata, transaction);
        const meta = transaction.getMeta(aiEditSelectionPluginKey) as AiEditSelectionMeta | undefined;
        return {
          metadata: applyMeta(mapped, meta)
        };
      }
    },
    props: {
      decorations(state) {
        return buildDecorationSet(state);
      }
    }
  });
}

export const AiEditSelections = Extension.create({
  name: "aiEditSelections",

  addExtensions() {
    return [AiEditRange];
  },

  addProseMirrorPlugins() {
    return [createAiEditSelectionPlugin()];
  }
});

export function getAiEditSelectionRange(state: EditorState, id: string) {
  // Prefer the plugin entry: it is rebased through every transaction's mapping
  // (local and remote collab steps), so it survives concurrent edits. A
  // collapsed entry (from === to) is a valid zero-width insertion point — the
  // selected text was deleted out from under the run, but we can still insert
  // the result at the recovered position.
  const entry = aiEditSelectionPluginKey.getState(state)?.metadata.get(id);
  if (entry) {
    const docSize = state.doc.content.size;
    const from = Math.max(0, Math.min(entry.from, docSize));
    const to = Math.max(from, Math.min(entry.to, docSize));
    return { from, to };
  }
  // Fallback: scan for a surviving mark (covers cold-load before the plugin
  // entry is re-seeded).
  return collectAiEditSelectionRanges(state.doc).get(id) ?? null;
}

// Where a finished run's replacement should land. An intact anchor (plugin
// entry or surviving mark — including the zero-width point a deleted range
// collapses to) wins. When the anchor is truly gone (e.g. a false "abandoned"
// failure already stripped the mark before the run actually finished), the
// result must still land SOMEWHERE visible: fall back to an end-of-document
// insertion point instead of dropping the agent's work. Callers use
// `anchorLost` to tell the user where the result went.
export function resolveAiEditApplyRange(
  state: EditorState,
  id: string
): { from: number; to: number; anchorLost: boolean } {
  const range = getAiEditSelectionRange(state, id);
  if (range) {
    return { ...range, anchorLost: false };
  }
  const end = state.doc.content.size;
  return { from: end, to: end, anchorLost: true };
}

// Re-pins every tracked selection's plugin entry to its true document position
// (from the surviving marks/atom attributes). Call this right after a full-doc
// `editor.commands.setContent(...)` remount: that remount's replace-everything
// step collapses every OTHER in-flight selection's anchor to the document end, so
// without this their results would be inserted at the bottom of the document
// instead of in place. Returns null when nothing needs re-pinning.
export function reseedAiEditSelectionsFromDoc(state: EditorState): Transaction | null {
  const ranges = collectAiEditSelectionRanges(state.doc);
  const pluginState = aiEditSelectionPluginKey.getState(state);
  const entries: Array<{ id: string; from: number; to: number }> = [];
  for (const [id, range] of ranges) {
    const current = pluginState?.metadata.get(id);
    if (current && current.from === range.from && current.to === range.to) continue;
    entries.push({ id, from: range.from, to: range.to });
  }
  if (entries.length === 0) return null;
  return state.tr.setMeta(aiEditSelectionPluginKey, { type: "reseed", entries } satisfies AiEditSelectionMeta);
}

export function describeAiEditSelectionPresence(state: EditorState, id: string) {
  const pluginState = aiEditSelectionPluginKey.getState(state);
  const pluginEntry = pluginState?.metadata.get(id) ?? null;
  const markRanges = findAiEditRangeMark(state, id)?.ranges ?? [];
  let totalMarkRangesAnyId = 0;
  state.doc.descendants((node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name === "aiEditRange") totalMarkRangesAnyId += 1;
    }
  });
  return {
    docSize: state.doc.content.size,
    pluginHasEntry: !!pluginEntry,
    pluginFrom: pluginEntry?.from ?? null,
    pluginTo: pluginEntry?.to ?? null,
    markRangeCountForId: markRanges.length,
    markRangeCountAnyId: totalMarkRangesAnyId,
    pluginMetadataKeys: pluginState ? Array.from(pluginState.metadata.keys()) : []
  };
}

export function getAiEditSelectionMetadata(state: EditorState, id: string) {
  return aiEditSelectionPluginKey.getState(state)?.metadata.get(id)?.metadata ?? null;
}

function findAiEditRangeMark(state: EditorState, selectionId: string) {
  const markType = state.schema.marks.aiEditRange;
  if (!markType) return null;
  const ranges: Array<{ from: number; to: number }> = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name === "aiEditRange" && markSelectionIds(mark).includes(selectionId)) {
        ranges.push({ from: pos, to: pos + node.nodeSize });
      }
    }
  });
  return ranges.length > 0 ? { markType, ranges } : null;
}

// Adds `id` to the aiEditRange mark over [from, to], UNIONING with any selection
// ids already there (so overlapping selections coexist instead of clobbering).
// Marks never shift positions, so capturing segments then rewriting them is safe.
function addMarkSelectionId(
  tr: Transaction,
  markType: NonNullable<EditorState["schema"]["marks"]["aiEditRange"]>,
  from: number,
  to: number,
  id: string
) {
  const segments: Array<{ from: number; to: number; ids: string[] }> = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const segFrom = Math.max(from, pos);
    const segTo = Math.min(to, pos + node.nodeSize);
    if (segTo <= segFrom) return;
    const existing = node.marks.find((mark) => mark.type === markType);
    const ids = existing ? markSelectionIds(existing) : [];
    if (!ids.includes(id)) segments.push({ from: segFrom, to: segTo, ids: [...ids, id] });
  });
  for (const seg of segments) {
    tr.removeMark(seg.from, seg.to, markType);
    tr.addMark(seg.from, seg.to, markType.create({ selectionIds: seg.ids }));
  }
}

// Removes `id` from every aiEditRange mark; a mark left with other ids keeps them.
function removeMarkSelectionId(
  tr: Transaction,
  markType: NonNullable<EditorState["schema"]["marks"]["aiEditRange"]>,
  id: string
) {
  const segments: Array<{ from: number; to: number; rest: string[] }> = [];
  tr.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const existing = node.marks.find((mark) => mark.type === markType);
    if (!existing) return;
    const ids = markSelectionIds(existing);
    if (ids.includes(id)) segments.push({ from: pos, to: pos + node.nodeSize, rest: ids.filter((value) => value !== id) });
  });
  for (const seg of segments) {
    tr.removeMark(seg.from, seg.to, markType);
    if (seg.rest.length > 0) tr.addMark(seg.from, seg.to, markType.create({ selectionIds: seg.rest }));
  }
}

export function upsertAiEditSelection(
  state: EditorState,
  marker: {
    id: string;
    from: number;
    to: number;
    runId?: string | null;
    progress?: string | null;
    source?: AiEditSelectionMetadata["source"];
  }
) {
  const docSize = state.doc.content.size;
  const from = Math.max(0, Math.min(marker.from, docSize));
  const to = Math.max(from, Math.min(marker.to, docSize));
  const tr = state.tr;

  if (to > from) {
    const markType = state.schema.marks.aiEditRange;
    if (markType) {
      addMarkSelectionId(tr, markType, from, to, marker.id);
    }
    // The inline mark cannot attach to block atoms in the range, so also anchor
    // any atoms (repoImage / embeddedWidget / image) via a node attribute that
    // survives an editor rebuild.
    setAtomAnchorsInRange(tr, marker.id, from, to, true);
  }

  tr.setMeta(aiEditSelectionPluginKey, {
    type: "upsertMetadata",
    id: marker.id,
    from,
    to,
    metadata: {
      runId: marker.runId ?? null,
      progress: marker.progress ?? null,
      source: marker.source ?? "local"
    }
  } satisfies AiEditSelectionMeta);

  return tr;
}

export function removeAiEditSelection(state: EditorState, id: string) {
  const tr = state.tr;
  const markType = state.schema.marks.aiEditRange;
  if (markType) {
    removeMarkSelectionId(tr, markType, id);
  }
  clearAtomAnchor(tr, id);
  tr.setMeta(aiEditSelectionPluginKey, {
    type: "removeMetadata",
    id
  } satisfies AiEditSelectionMeta);
  return tr;
}

export function syncAiEditSelectionRuns(
  state: EditorState,
  runs: Array<{ run: ActiveAiRunView; selectionId: string }>,
  settledSelectionIds: string[] = []
) {
  return state.tr.setMeta(aiEditSelectionPluginKey, {
    type: "syncRuns",
    entries: runs.map(({ run, selectionId }) => ({
      id: selectionId,
      metadata: {
        runId: run.id,
        progress: getAiRunProgressLabel(run),
        source: "run" as const
      }
    })),
    settledIds: settledSelectionIds
  } satisfies AiEditSelectionMeta);
}

export function aiEditRunSelectionId(run: ActiveAiRunView): string | null {
  if (run.triggerType !== "SELECTION_EDIT") return null;
  return run.selectionId ?? parseAiRunSelectionId(run.triggerId);
}

// The selection ids whose anchors (marks / atom attrs) cleanupStaleAiEditRangeMarks
// must leave alone. Pass the FULL polled run list, not just the running ones: a
// SUCCEEDED run whose replacement has not been applied yet still needs its anchor
// — cleaning it up makes the apply find no marker and silently drop the result.
// FAILED runs are deliberately unprotected here; the failed-run handler re-arms
// the marker itself for same-session retries.
export function aiEditSelectionIdsToProtect(runs: ActiveAiRunView[]): Set<string> {
  const ids = new Set<string>();
  for (const run of runs) {
    if (run.status === "FAILED") continue;
    if (run.status === "SUCCEEDED" && run.appliedAt) continue;
    const selectionId = aiEditRunSelectionId(run);
    if (selectionId) ids.add(selectionId);
  }
  return ids;
}

// Mount-time wrapper around cleanupStaleAiEditRangeMarks. `runsLoaded` must be
// true only once the FIRST server-derived run list has arrived: sweeping
// against the initial empty list protects nothing and strips every anchor —
// including the mark a SUCCEEDED-but-unapplied run needs to land its result —
// which made every fresh page load eat pending results as "marker lost".
export function cleanupStaleAiEditRangeMarksAfterRunsLoaded(
  state: EditorState,
  runs: ActiveAiRunView[],
  runsLoaded: boolean
): Transaction | null {
  if (!runsLoaded) return null;
  return cleanupStaleAiEditRangeMarks(state, aiEditSelectionIdsToProtect(runs));
}

export function cleanupStaleAiEditRangeMarks(state: EditorState, activeSelectionIds: Set<string>): Transaction | null {
  const ranges = collectAiEditSelectionRanges(state.doc);
  const stale: string[] = [];
  for (const id of ranges.keys()) {
    if (!activeSelectionIds.has(id)) {
      stale.push(id);
    }
  }
  if (stale.length === 0) return null;
  const tr = state.tr;
  const markType = state.schema.marks.aiEditRange;
  for (const id of stale) {
    // Subtract just this id; a mark shared with a still-active selection keeps it.
    if (markType) removeMarkSelectionId(tr, markType, id);
    // Strip the atom anchor too, so a reload after an interrupted run doesn't leave
    // a stale selection id baked into a repoImage / widget / image node.
    clearAtomAnchor(tr, id);
  }
  return tr.docChanged ? tr : null;
}
