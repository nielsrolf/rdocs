"use client";

import { useSyncExternalStore } from "react";

// The forum page renders the comment section and the outline sidebar as
// separate trees (the sidebar lives inside DocumentWorkspace), so the comment
// section publishes its current tree here and the sidebar subscribes.
// Keyed by document id: a quicktake feed renders one comment section each.

type Listener = () => void;

const snapshots = new Map<string, unknown>();
const listeners = new Map<string, Set<Listener>>();

export function publishForumComments<T>(documentId: string, comments: T) {
  snapshots.set(documentId, comments);
  listeners.get(documentId)?.forEach((listener) => listener());
}

export function useForumComments<T>(documentId: string, fallback: T): T {
  return useSyncExternalStore(
    (listener) => {
      let set = listeners.get(documentId);
      if (!set) {
        set = new Set();
        listeners.set(documentId, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
      };
    },
    () => (snapshots.get(documentId) as T | undefined) ?? fallback,
    () => fallback
  );
}
