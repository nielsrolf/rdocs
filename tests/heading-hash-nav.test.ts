import assert from "node:assert/strict";
import test from "node:test";

import { createHeadingHashNav, type HashNavEntry } from "../components/document-workspace/heading-hash-nav";

// Manual timer queue so tests control retry scheduling deterministically.
function makeTimers() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  return {
    setTimeoutFn: (fn: () => void, _delay: number) => {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeoutFn: (id: number) => {
      pending.delete(id);
    },
    runAll() {
      // Run currently pending timers only (new ones scheduled during run wait).
      const batch = [...pending.entries()];
      for (const [id, fn] of batch) {
        pending.delete(id);
        fn();
      }
    },
    get count() {
      return pending.size;
    }
  };
}

test("hash nav retries with fresh entries: succeeds after tab metadata loads", () => {
  const timers = makeTimers();
  // Reproduces the reported bug: on initial load the outline entries are
  // computed before tabs load (tabId null), the heading is hidden in an
  // inactive tab so scrolling fails; once entries refresh with the real
  // tabId, navigation must still complete instead of being deduped away.
  let entries: HashNavEntry[] = [{ slug: "results", tabId: null }];
  let activeTabId: string | null = "tab-1";
  const selected: string[] = [];
  const scrolled: string[] = [];

  const nav = createHeadingHashNav({
    getHash: () => "results",
    getEntries: () => entries,
    attemptScroll: (entry) => {
      if (entry.tabId && entry.tabId !== activeTabId) {
        selected.push(entry.tabId);
        activeTabId = entry.tabId;
        return false; // tab switch is async in the real app; scroll lands on retry
      }
      if (entry.tabId && entry.tabId === activeTabId) {
        scrolled.push(entry.slug);
        return true;
      }
      // tabId unknown yet -> heading hidden, coordsAtPos throws in the real app
      return false;
    },
    setTimeoutFn: timers.setTimeoutFn as unknown as typeof setTimeout,
    clearTimeoutFn: timers.clearTimeoutFn as unknown as typeof clearTimeout
  });

  nav.onEntriesChanged();
  timers.runAll(); // all attempts fail: tabId unknown

  assert.equal(scrolled.length, 0);

  // Tabs load; entries refresh with the owning tab.
  entries = [{ slug: "results", tabId: "tab-2" }];
  nav.onEntriesChanged();
  timers.runAll(); // first attempt switches tab
  timers.runAll(); // retry scrolls

  assert.deepEqual(selected, ["tab-2"]);
  assert.deepEqual(scrolled, ["results"]);

  // Once done, further entry churn must not scroll again.
  nav.onEntriesChanged();
  timers.runAll();
  assert.deepEqual(scrolled, ["results"]);
});

test("hash nav re-arms on hashchange to a different heading", () => {
  const timers = makeTimers();
  let hash = "intro";
  const scrolled: string[] = [];
  const nav = createHeadingHashNav({
    getHash: () => hash,
    getEntries: () => [
      { slug: "intro", tabId: null },
      { slug: "details", tabId: null }
    ],
    attemptScroll: (entry) => {
      scrolled.push(entry.slug);
      return true;
    },
    setTimeoutFn: timers.setTimeoutFn as unknown as typeof setTimeout,
    clearTimeoutFn: timers.clearTimeoutFn as unknown as typeof clearTimeout
  });

  nav.onEntriesChanged();
  timers.runAll();
  assert.deepEqual(scrolled, ["intro"]);

  hash = "details";
  nav.onHashChange();
  timers.runAll();
  assert.deepEqual(scrolled, ["intro", "details"]);
});

test("hash nav does nothing without a hash and stops cleanly", () => {
  const timers = makeTimers();
  const nav = createHeadingHashNav({
    getHash: () => "",
    getEntries: () => [{ slug: "intro", tabId: null }],
    attemptScroll: () => {
      throw new Error("should not attempt");
    },
    setTimeoutFn: timers.setTimeoutFn as unknown as typeof setTimeout,
    clearTimeoutFn: timers.clearTimeoutFn as unknown as typeof clearTimeout
  });

  nav.onEntriesChanged();
  assert.equal(timers.count, 0);
  nav.stop();
});
