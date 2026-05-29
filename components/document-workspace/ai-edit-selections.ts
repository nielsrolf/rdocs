import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { getAiRunProgressLabel } from "./utils";
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
  | { type: "syncRuns"; entries: Array<{ id: string; metadata: AiEditSelectionMetadata }> };

export const aiEditSelectionPluginKey = new PluginKey<AiEditSelectionState>("ai-edit-selections");

export const AiEditRange = Mark.create({
  name: "aiEditRange",
  inclusive: false,
  spanning: true,
  addAttributes() {
    return {
      selectionId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-ai-edit-id"),
        renderHTML: (attributes) =>
          typeof attributes.selectionId === "string" && attributes.selectionId
            ? { "data-ai-edit-id": attributes.selectionId }
            : {}
      }
    };
  },
  parseHTML() {
    return [{ tag: "span[data-ai-edit-id]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  }
});

export function collectAiEditSelectionRanges(doc: EditorState["doc"]) {
  const ranges = new Map<string, { from: number; to: number }>();

  doc.descendants((node, pos) => {
    if (!node.isText) {
      return;
    }

    for (const mark of node.marks) {
      if (mark.type.name !== "aiEditRange") continue;
      const selectionId = mark.attrs.selectionId;
      if (typeof selectionId !== "string" || !selectionId) continue;

      const from = pos;
      const to = pos + node.nodeSize;
      const current = ranges.get(selectionId);
      ranges.set(selectionId, {
        from: current ? Math.min(current.from, from) : from,
        to: current ? Math.max(current.to, to) : to
      });
    }
  });

  return ranges;
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
      if (mark.type.name === "aiEditRange" && mark.attrs.selectionId === selectionId) {
        ranges.push({ from: pos, to: pos + node.nodeSize });
      }
    }
  });
  return ranges.length > 0 ? { markType, ranges } : null;
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
      const existing = findAiEditRangeMark(state, marker.id);
      if (existing) {
        for (let i = existing.ranges.length - 1; i >= 0; i--) {
          const range = existing.ranges[i];
          tr.removeMark(range.from, range.to, markType);
        }
      }
      tr.addMark(from, to, markType.create({ selectionId: marker.id }));
    }
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
    const existing = findAiEditRangeMark(state, id);
    if (existing) {
      for (let i = existing.ranges.length - 1; i >= 0; i--) {
        const range = existing.ranges[i];
        tr.removeMark(range.from, range.to, markType);
      }
    }
  }
  tr.setMeta(aiEditSelectionPluginKey, {
    type: "removeMetadata",
    id
  } satisfies AiEditSelectionMeta);
  return tr;
}

export function syncAiEditSelectionRuns(
  state: EditorState,
  runs: Array<{ run: ActiveAiRunView; selectionId: string }>
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
    }))
  } satisfies AiEditSelectionMeta);
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
  const markType = state.schema.marks.aiEditRange;
  if (!markType) return null;
  const tr = state.tr;
  for (const id of stale) {
    const existing = findAiEditRangeMark(state, id);
    if (!existing) continue;
    for (let i = existing.ranges.length - 1; i >= 0; i--) {
      const range = existing.ranges[i];
      tr.removeMark(range.from, range.to, markType);
    }
  }
  return tr.docChanged ? tr : null;
}
