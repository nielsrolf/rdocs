// In-process registry of cancellable agent runs. Each background run function
// registers an AbortController under its aiRunId for the duration of the run;
// the cancel action on the run route looks it up and aborts. This only reaches
// runs owned by the CURRENT server process — which is exactly the case that
// used to force a whole-service restart. Runs orphaned by a restart are already
// handled by the boot sweep (instrumentation.ts) and the silence reaper.

const controllers = new Map<string, AbortController>();

export const RUN_CANCELLED_MESSAGE = "Cancelled by user.";

export class RunCancelledError extends Error {
  constructor() {
    super(RUN_CANCELLED_MESSAGE);
    this.name = "RunCancelledError";
  }
}

export function registerRunAbortController(aiRunId: string): AbortController {
  const controller = new AbortController();
  controllers.set(aiRunId, controller);
  return controller;
}

// Idempotent; must run in the background runner's finally so a finished run
// can never be "cancelled" into a stale registry entry.
export function deregisterRunAbortController(aiRunId: string) {
  controllers.delete(aiRunId);
}

/** Abort a run owned by this process. Returns false when unknown (finished, or owned by another process). */
export function cancelAiRun(aiRunId: string): boolean {
  const controller = controllers.get(aiRunId);
  if (!controller) {
    return false;
  }
  controller.abort(new RunCancelledError());
  return true;
}

export function isCancellableAiRun(aiRunId: string): boolean {
  return controllers.has(aiRunId);
}

/**
 * How many agent runs THIS process currently owns. Every background runner
 * registers here for its full lifetime (register in the route, deregister in
 * the runner's finally), so this is the drain criterion for graceful
 * shutdown: zero means no in-flight work would die with the process.
 */
export function activeRunCount(): number {
  return controllers.size;
}

// A run's failure is a user cancellation when its signal was aborted —
// regardless of what error actually surfaced (the killed container manifests
// as "exited without a result", the SDK as an AbortError, etc.).
export function isRunCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  return error instanceof Error && (error.name === "RunCancelledError" || error.message === RUN_CANCELLED_MESSAGE);
}
