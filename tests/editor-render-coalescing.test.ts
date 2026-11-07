import assert from "node:assert/strict";
import test from "node:test";

import {
  createTrailingThrottle,
  keepIfUnchanged,
  tabsEqual
} from "../components/document-workspace/render-coalescing";

// Live collaboration lag: every transaction (each local keystroke, each remote
// step, each presence-refresh meta) used to re-render the whole
// DocumentWorkspace, and several doc-derived states were re-set with fresh
// identities on every change. These seams batch that work.

test("trailing throttle: a burst of doc changes yields ONE refresh after the window", async () => {
  let calls = 0;
  const throttle = createTrailingThrottle(() => {
    calls += 1;
  }, 30);

  for (let i = 0; i < 25; i += 1) throttle.schedule(); // a fast typist's burst
  assert.equal(calls, 0, "nothing runs synchronously on the keystroke");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls, 1);

  // Continuous typing still refreshes periodically (throttle, not debounce).
  throttle.schedule();
  await new Promise((resolve) => setTimeout(resolve, 10));
  throttle.schedule();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, 2);
  throttle.cancel();
});

test("trailing throttle: cancel drops a pending refresh", async () => {
  let calls = 0;
  const throttle = createTrailingThrottle(() => {
    calls += 1;
  }, 20);
  throttle.schedule();
  throttle.cancel();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, 0);
});

test("tabsEqual: identical tab lists compare equal, any field change does not", () => {
  const a = [
    { id: "t1", title: "One", breakPos: 0, contentFrom: 1, contentTo: 10 },
    { id: "t2", title: "Two", breakPos: 10, contentFrom: 11, contentTo: 20 }
  ];
  assert.ok(tabsEqual(a, a.map((tab) => ({ ...tab }))));
  assert.ok(tabsEqual([], []));
  assert.ok(!tabsEqual(a, [a[0]]));
  assert.ok(!tabsEqual(a, [a[0], { ...a[1], contentTo: 21 }]));
  assert.ok(!tabsEqual(a, [a[0], { ...a[1], title: "Zwei" }]));
});

test("keepIfUnchanged: a no-op poll keeps the previous identity (no re-render)", () => {
  const previous = [{ id: "th1", comments: [{ id: "c1", body: "hi" }] }];
  const same = JSON.parse(JSON.stringify(previous));
  assert.equal(keepIfUnchanged(previous, same), previous);
  const changed = [{ id: "th1", comments: [{ id: "c1", body: "hi!" }] }];
  assert.equal(keepIfUnchanged(previous, changed), changed);
});
