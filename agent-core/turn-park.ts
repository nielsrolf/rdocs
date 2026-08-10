// Keep-alive parking for a turn that is waiting on a check_back_later alarm.
//
// The old contract for long background work was "detach and die": the agent
// launched a job with nohup, scheduled a wake-up, submitted, and the run ended.
// That is a lie inside a container run: the run's container is `docker run --rm`
// and its /workspace is a per-run worktree, so when the run ends PID 1 exits,
// the detached child dies with it, and the worktree is removed. The woken run
// then finds neither process nor logs.
//
// So instead we PARK: when check_back_later succeeds, the steering input channel
// is left OPEN after the turn's result frame. The SDK session sits idle waiting
// for the next user message (costing nothing), the container and worktree stay
// alive with it, and the scheduler's wake-up is INJECTED into the same live
// session — the same path a mid-run Slack message takes. The run therefore stays
// RUNNING (👀 on the user's message) until the agent actually submits, which is
// also what makes ✅ mean "everything is done".
//
// Two bounds keep a park from becoming a leak:
//   * MAX_KEEP_ALIVE_MINUTES — longer waits fall back to detach-and-die, since
//     an idle container that pins a blue/green drain for hours is worse than a
//     fresh wake-up run.
//   * the park deadline (wake-up delay + grace) — if the wake-up never arrives
//     (lost beat, deploy, scheduler down) the host nudges the agent to wrap up
//     instead of idling until the reaper or the process replacement kills it.
export const MAX_KEEP_ALIVE_MINUTES = 120;
export const PARK_GRACE_MS = 5 * 60 * 1000;

export const PARK_TIMEOUT_NUDGE =
  "[System] Your check-back wake-up never arrived (the scheduler beat was lost, or the server was replaced). Do not wait any longer: check the state of whatever you started, then finish this turn with submit_response. If the work is still unfinished and needs another wait, call check_back_later again first.";

export type TurnPark = {
  /**
   * Arm the park for a wake-up `afterMinutes` from now. Returns false when the
   * wait is too long to hold a session open — the caller must then keep the
   * historical detach-and-die semantics.
   */
  arm(afterMinutes: number): boolean;
  isArmed(): boolean;
  disarm(): void;
  deadlineMs(): number | null;
  /** Milliseconds until the park deadline (0 once it has passed). */
  remainingMs(): number;
};

export function createTurnPark(options?: {
  maxKeepAliveMinutes?: number;
  graceMs?: number;
  now?: () => number;
}): TurnPark {
  const maxMinutes = options?.maxKeepAliveMinutes ?? MAX_KEEP_ALIVE_MINUTES;
  const graceMs = options?.graceMs ?? PARK_GRACE_MS;
  const now = options?.now ?? (() => Date.now());
  let deadline: number | null = null;

  return {
    arm(afterMinutes: number) {
      if (!Number.isFinite(afterMinutes) || afterMinutes <= 0) return false;
      if (afterMinutes > maxMinutes) return false;
      deadline = now() + afterMinutes * 60_000 + graceMs;
      return true;
    },
    isArmed() {
      return deadline != null && now() < deadline;
    },
    disarm() {
      deadline = null;
    },
    deadlineMs() {
      return deadline;
    },
    remainingMs() {
      if (deadline == null) return 0;
      return Math.max(0, deadline - now());
    }
  };
}
