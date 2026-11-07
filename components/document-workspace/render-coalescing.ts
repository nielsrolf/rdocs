// Helpers that keep live collaboration from re-rendering the whole
// DocumentWorkspace on every keystroke / remote step. The editor runs with
// `shouldRerenderOnTransaction: false`; doc-derived React state (comment
// anchors, tab list, word count, suggestion list) is refreshed on a short
// trailing throttle instead, and only re-set when it actually changed.

import type { TabSummary } from "./tabs";

// How long doc-derived UI state may lag behind the document. Short enough that
// the comment rail / outline feel live, long enough that a fast typist (or a
// collaborator's typing) costs a few renders per second instead of one or more
// per keystroke.
export const DOC_DERIVED_REFRESH_MS = 200;

// Trailing throttle: the first schedule() arms a timer; further calls inside
// the window are absorbed; when it fires, `run` reads the CURRENT state. Unlike
// a debounce, continuous typing still refreshes every `ms`.
export function createTrailingThrottle(run: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule() {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        run();
      }, ms);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

export function tabsEqual(a: readonly TabSummary[], b: readonly TabSummary[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.title !== y.title ||
      x.breakPos !== y.breakPos ||
      x.contentFrom !== y.contentFrom ||
      x.contentTo !== y.contentTo
    ) {
      return false;
    }
  }
  return true;
}

// For setState updaters fed by polls / recomputations that return fresh object
// identities: keep the previous value when the content is the same, so React
// bails out instead of re-rendering (and re-running effects keyed on it).
export function keepIfUnchanged<T>(previous: T, next: T): T {
  if (previous === next) return previous;
  try {
    return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
  } catch {
    return next;
  }
}
