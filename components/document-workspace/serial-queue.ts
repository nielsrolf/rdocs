// A minimal FIFO queue that runs async tasks strictly one-at-a-time.
//
// AI-edit runs are applied by a polling effect that dispatches each finished run
// fire-and-forget. When two runs finish in the same poll cycle they used to apply
// concurrently, and because applyAiEditRun ends by remounting the editor via
// `setContent(snapshotTakenEarlier)`, the second apply would reset the document to a
// stale snapshot and silently drop the first run's content. Routing every apply
// through this queue guarantees each run's insert → save → remount completes before
// the next one reads the editor, so their edits compose instead of clobbering.
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      // Chain onto the tail regardless of whether the previous task resolved or
      // rejected, so one failed apply can't wedge the queue.
      const result = tail.then(task, task);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
