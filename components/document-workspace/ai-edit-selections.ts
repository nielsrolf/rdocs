import { Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { getAiRunProgressLabel } from "./utils";
import type { ActiveAiRunView } from "./types";

export type AiEditSelectionMarker = {
  id: string;
  from: number;
  to: number;
  runId?: string | null;
  progress?: string | null;
  source: "local" | "run";
};

type AiEditSelectionState = {
  markers: Map<string, AiEditSelectionMarker>;
  decorations: DecorationSet;
};

type AiEditSelectionMeta =
  | {
      type: "upsert";
      marker: AiEditSelectionMarker;
    }
  | {
      type: "remove";
      id: string;
    }
  | {
      type: "syncRuns";
      markers: AiEditSelectionMarker[];
    };

export const aiEditSelectionPluginKey = new PluginKey<AiEditSelectionState>("ai-edit-selections");

function boundPosition(position: number, docSize: number) {
  return Math.max(0, Math.min(position, docSize));
}

function normalizeMarker(marker: AiEditSelectionMarker, docSize: number): AiEditSelectionMarker | null {
  const from = boundPosition(marker.from, docSize);
  const to = boundPosition(marker.to, docSize);
  if (from >= to) {
    return null;
  }

  return {
    ...marker,
    from,
    to
  };
}

function buildDecorationSet(state: EditorState, markers: Map<string, AiEditSelectionMarker>) {
  const decorations: Decoration[] = [];
  for (const marker of markers.values()) {
    decorations.push(
      Decoration.inline(
        marker.from,
        marker.to,
        {
          class: "ai-edit-selection-pending",
          "data-ai-edit-id": marker.id
        },
        { key: `ai-edit-selection-${marker.id}` }
      )
    );
  }

  return DecorationSet.create(state.doc, decorations);
}

function applyMeta(
  state: EditorState,
  markers: Map<string, AiEditSelectionMarker>,
  meta: AiEditSelectionMeta | undefined
) {
  if (!meta) {
    return markers;
  }

  const next = new Map(markers);

  if (meta.type === "remove") {
    next.delete(meta.id);
    return next;
  }

  if (meta.type === "upsert") {
    const normalized = normalizeMarker(meta.marker, state.doc.content.size);
    if (normalized) {
      next.set(normalized.id, normalized);
    } else {
      next.delete(meta.marker.id);
    }
    return next;
  }

  const syncedIds = new Set(meta.markers.map((marker) => marker.id));
  for (const [id, marker] of next) {
    if (marker.source === "run" && !syncedIds.has(id)) {
      next.delete(id);
    }
  }

  for (const marker of meta.markers) {
    const current = next.get(marker.id);
    const normalized = normalizeMarker(
      {
        ...marker,
        source: current?.source ?? marker.source,
        from: current?.from ?? marker.from,
        to: current?.to ?? marker.to
      },
      state.doc.content.size
    );

    if (normalized) {
      next.set(normalized.id, normalized);
    }
  }

  return next;
}

export const AiEditSelections = Extension.create({
  name: "aiEditSelections",

  addProseMirrorPlugins() {
    return [
      new Plugin<AiEditSelectionState>({
        key: aiEditSelectionPluginKey,
        state: {
          init: (_config, state) => {
            const markers = new Map<string, AiEditSelectionMarker>();
            return {
              markers,
              decorations: buildDecorationSet(state, markers)
            };
          },
          apply: (transaction, previous, _oldState, newState) => {
            const mappedMarkers = new Map<string, AiEditSelectionMarker>();
            for (const marker of previous.markers.values()) {
              const from = transaction.mapping.map(marker.from, 1);
              const to = transaction.mapping.map(marker.to, -1);
              const normalized = normalizeMarker({ ...marker, from, to }, newState.doc.content.size);
              if (normalized) {
                mappedMarkers.set(normalized.id, normalized);
              }
            }

            const markers = applyMeta(
              newState,
              mappedMarkers,
              transaction.getMeta(aiEditSelectionPluginKey) as AiEditSelectionMeta | undefined
            );

            return {
              markers,
              decorations: buildDecorationSet(newState, markers)
            };
          }
        },
        props: {
          decorations(state) {
            return aiEditSelectionPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
          }
        }
      })
    ];
  }
});

export function getAiEditSelectionRange(state: EditorState, id: string) {
  const marker = aiEditSelectionPluginKey.getState(state)?.markers.get(id);
  return marker ? { from: marker.from, to: marker.to } : null;
}

export function upsertAiEditSelection(
  state: EditorState,
  marker: Omit<AiEditSelectionMarker, "source"> & { source?: AiEditSelectionMarker["source"] }
) {
  return state.tr.setMeta(aiEditSelectionPluginKey, {
    type: "upsert",
    marker: {
      ...marker,
      source: marker.source ?? "local"
    }
  } satisfies AiEditSelectionMeta);
}

export function removeAiEditSelection(state: EditorState, id: string) {
  return state.tr.setMeta(aiEditSelectionPluginKey, {
    type: "remove",
    id
  } satisfies AiEditSelectionMeta);
}

export function syncAiEditSelectionRuns(
  state: EditorState,
  runs: Array<{
    run: ActiveAiRunView;
    markerId: string;
    from: number;
    to: number;
  }>
) {
  return state.tr.setMeta(aiEditSelectionPluginKey, {
    type: "syncRuns",
    markers: runs.map(({ run, markerId, from, to }) => ({
      id: markerId,
      from,
      to,
      runId: run.id,
      progress: getAiRunProgressLabel(run),
      source: "run"
    }))
  } satisfies AiEditSelectionMeta);
}
