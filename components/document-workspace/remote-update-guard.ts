/**
 * Defers a callback to run "after the current synchronous work settles", using
 * a mechanism that STILL FIRES while the tab is backgrounded/hidden.
 *
 * Why this exists: applying remote/programmatic editor updates flips the
 * `isApplyingRemoteUpdateRef` guard to `true` so the resulting `onUpdate` is not
 * echoed back to the server as a local change. The guard is reset on a deferred
 * tick. We used to defer that reset with `requestAnimationFrame`, but browsers
 * FREEZE rAF callbacks in backgrounded tabs. A collaboration pull that applied
 * remote steps while the tab was in the background therefore left the guard
 * stuck `true` forever — after which `onUpdate` early-returned for every
 * keystroke, no collaboration flush was ever scheduled, and the document was
 * silently never saved again ("forever Saving", with an unsaved-changes prompt
 * on close and no error reaching the server or client log).
 *
 * `queueMicrotask` is not subject to background-tab throttling and runs right
 * after the current call stack unwinds — which is after the synchronous
 * `editor.view.dispatch(...)` (and its synchronous `onUpdate`) has already run,
 * so the guard still covers the echoed update. `setTimeout` is the fallback for
 * environments without `queueMicrotask`; unlike rAF it also fires in the
 * background (throttled, but it fires).
 */
export function deferToForeground(cb: () => void): void {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(cb);
    return;
  }
  setTimeout(cb, 0);
}
