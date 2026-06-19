import assert from "node:assert/strict";
import { test } from "node:test";

import { deferToForeground } from "../components/document-workspace/remote-update-guard";

// Regression: applying a remote collaboration update flips the
// `isApplyingRemoteUpdateRef` guard to `true` and schedules a reset on a
// deferred tick. The reset used to be scheduled with `requestAnimationFrame`,
// which browsers FREEZE in backgrounded/hidden tabs. A collab pull that applied
// remote steps while the tab was backgrounded left the guard stuck `true`
// forever; `onUpdate` then early-returned for every keystroke and the document
// was silently never saved again ("forever Saving"). The reset must use a
// mechanism that still fires while the tab is backgrounded.
test("deferToForeground resets even when requestAnimationFrame is frozen (backgrounded tab)", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevRaf = g.requestAnimationFrame;
  const prevWindow = g.window;

  // Simulate a backgrounded tab: rAF callbacks are queued but never fire.
  const frozenRafCallbacks: Array<() => void> = [];
  const frozenRaf = (cb: () => void) => {
    frozenRafCallbacks.push(cb);
    return 1;
  };
  g.requestAnimationFrame = frozenRaf;
  g.window = { requestAnimationFrame: frozenRaf };

  try {
    let didReset = false;
    deferToForeground(() => {
      didReset = true;
    });

    // Flush microtasks + macrotasks. rAF deliberately stays frozen.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(
      didReset,
      true,
      "guard reset must fire even when requestAnimationFrame never runs"
    );
    assert.equal(
      frozenRafCallbacks.length,
      0,
      "guard reset must not depend on requestAnimationFrame"
    );
  } finally {
    g.requestAnimationFrame = prevRaf;
    g.window = prevWindow;
  }
});
