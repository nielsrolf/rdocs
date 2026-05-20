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

type AiEditSelectionState = {
  metadata: Map<string, AiEditSelectionMetadata>;
};

type AiEditSelectionMeta =
  | { type: "upsertMetadata"; id: string; metadata: AiEditSelectionMetadata }
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

function applyMeta(
  metadata: Map<string, AiEditSelectionMetadata>,
  meta: AiEditSelectionMeta | undefined
) {
  if (!meta) return metadata;

  const next = new Map(metadata);
  if (meta.type === "removeMetadata") {
    next.delete(meta.id);
    return next;
  }
  if (meta.type === "upsertMetadata") {
    next.set(meta.id, meta.metadata);
    return next;
  }

  const syncedIds = new Set(meta.entries.map((entry) => entry.id));
  for (const [id, value] of next) {
    if (value.source === "run" && !syncedIds.has(id)) {
      next.delete(id);
    }
  }
  for (const entry of meta.entries) {
    const current = next.get(entry.id);
    next.set(entry.id, {
      ...entry.metadata,
      source: current?.source ?? entry.metadata.source
    });
  }
  return next;
}

function buildDecorationSet(state: EditorState) {
  const ranges = collectAiEditSelectionRanges(state.doc);
  const decorations: Decoration[] = [];
  for (const [selectionId, range] of ranges) {
    decorations.push(
      Decoration.inline(
        range.from,
        range.to,
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

export const AiEditSelections = Extension.create({
  name: "aiEditSelections",

  addExtensions() {
    return [AiEditRange];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<AiEditSelectionState>({
        key: aiEditSelectionPluginKey,
        state: {
          init: () => ({ metadata: new Map() }),
          apply: (transaction, previous) => {
            const meta = transaction.getMeta(aiEditSelectionPluginKey) as AiEditSelectionMeta | undefined;
            return {
              metadata: applyMeta(previous.metadata, meta)
            };
          }
        },
        props: {
          decorations(state) {
            return buildDecorationSet(state);
          }
        }
      })
    ];
  }
});

export function getAiEditSelectionRange(state: EditorState, id: string) {
  return collectAiEditSelectionRanges(state.doc).get(id) ?? null;
}

export function getAiEditSelectionMetadata(state: EditorState, id: string) {
  return aiEditSelectionPluginKey.getState(state)?.metadata.get(id) ?? null;
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
