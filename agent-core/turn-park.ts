// Keep-alive parking for a turn that is waiting on background work.
//
// The old contract for long background work was "detach and die": the agent
// launched a job with nohup, scheduled a wake-up, submitted, and the run ended.
// That is a lie inside a container run: the run's container is `docker run --rm`
// and its /workspace is a per-run worktree, so when the run ends PID 1 exits,
// the detached child dies with it, and the worktree is removed. The woken run
// then finds neither process nor logs.
//
// So instead we PARK: the steering input channel is left OPEN after the turn's
// result frame. The SDK session sits idle waiting for the next user message
// (costing nothing), the container and worktree stay alive with it, and any
// wake-up / user message is INJECTED into the same live session. The run stays
// RUNNING (👀 on the user's message) until the agent actually submits, which is
// also what makes ✅ mean "everything is done".
//
// TWO park conditions, deliberately independent (see the 2026-08-10 incident:
// a user message delivered into an alarm-park disarmed it, the agent replied
// without re-arming, the run finalized and its background sweep died):
//
//   * ALARM park — armed by a successful check_back_later within
//     MAX_KEEP_ALIVE_MINUTES. Event-based: delivery of any message disarms it,
//     because the wake-up (or an earlier user message) has arrived and the next
//     turn decides fresh. Deadline = delay + grace, after which the host nudges
//     the agent to wrap up instead of idling forever.
//
//   * KEEP-ALIVE — set by the agent via keep_alive_after_turn(true), or the
//     question the host asks when it OBSERVES live background work at a turn
//     boundary. State-based: it survives message delivery and turn boundaries
//     until the agent explicitly sets it to false, the absolute TTL expires, or
//     the run submits. While on, the host re-checks in with the agent every
//     KEEP_ALIVE_RECHECK_MS so a forgotten daemon cannot pin a container
//     silently forever.
export const MAX_KEEP_ALIVE_MINUTES = 120;
export const PARK_GRACE_MS = 5 * 60 * 1000;
/** How often a keep-alive park asks the agent to confirm it is still needed. */
export const KEEP_ALIVE_RECHECK_MS = 30 * 60 * 1000;
/** Absolute ceiling for a keep-alive park (policy knob, not a deploy artifact). */
export const KEEP_ALIVE_MAX_TOTAL_MS = 24 * 60 * 60 * 1000;

export const PARK_TIMEOUT_NUDGE =
  "[System] Your check-back wake-up never arrived (the scheduler beat was lost, or the server was replaced). Do not wait any longer: check the state of whatever you started, then finish this turn with submit_response. If the work is still unfinished and needs another wait, call check_back_later again first.";

export const KEEP_ALIVE_RECHECK_NUDGE =
  "[System] Keep-alive check-in: this session is being kept alive because you enabled keep_alive_after_turn (background work). Check the state of your background tasks now. If everything is finished, call keep_alive_after_turn with enabled=false and submit your final response. If work is still running, post a one-line status with post_slack_message if the user should know, then simply end your turn — the session stays alive and you will be checked on again.";

export const KEEP_ALIVE_EXPIRED_NUDGE =
  "[System] Keep-alive limit reached: this session has been kept alive for the maximum allowed time and will NOT be extended. Wrap up now: capture any state your background tasks produced (commit files, note log locations), post a status if needed, then submit your final response. If the work needs to continue beyond this session, schedule a wake-up with check_back_later or schedule_task first — the follow-up run must be able to resume from committed state.";

export function buildBackgroundWorkQuestion(tasks: string[]): string {
  const list = tasks
    .slice(0, 12)
    .map((task) => `  - ${task}`)
    .join("\n");
  return `[System] Your turn ended, but background work appears to still be running in this session:\n${list}\nEnding the run now would kill it (the container and its processes are released). Decide explicitly:\n- If this work matters and you know when to check on it: call check_back_later with a delay.\n- If it matters but the timing is open-ended: call keep_alive_after_turn with enabled=true.\n- If it can be discarded (leftover server, tail, watcher): call keep_alive_after_turn with enabled=false.\nThen end your turn (or submit your final response if you are done and chose to discard).`;
}

export type TurnPark = {
  /**
   * Arm the ALARM park for a wake-up `afterMinutes` from now. Returns false
   * when the wait is too long to hold a session open — the caller must then
   * keep the historical detach-and-die semantics.
   */
  arm(afterMinutes: number): boolean;
  isArmed(): boolean;
  /** Clears the ALARM park only. Keep-alive deliberately survives this. */
  disarm(): void;
  deadlineMs(): number | null;
  /** Milliseconds until the alarm park deadline (0 once it has passed). */
  remainingMs(): number;
  /**
   * Agent-controlled keep-alive. "unset" until the agent decides; an explicit
   * false is remembered so the host never asks about background work twice.
   */
  setKeepAlive(enabled: boolean): void;
  keepAliveEnabled(): boolean;
  keepAliveState(): "unset" | "on" | "off";
  /** True once a keep-alive park has exceeded its absolute TTL. */
  keepAliveExpired(): boolean;
  /** Should the input channel stay open at a result frame? */
  holdsOpen(): boolean;
};

export function createTurnPark(options?: {
  maxKeepAliveMinutes?: number;
  graceMs?: number;
  keepAliveMaxTotalMs?: number;
  now?: () => number;
}): TurnPark {
  const maxMinutes = options?.maxKeepAliveMinutes ?? MAX_KEEP_ALIVE_MINUTES;
  const graceMs = options?.graceMs ?? PARK_GRACE_MS;
  const keepAliveMaxTotalMs = options?.keepAliveMaxTotalMs ?? KEEP_ALIVE_MAX_TOTAL_MS;
  const now = options?.now ?? (() => Date.now());
  let deadline: number | null = null;
  let keepAlive: "unset" | "on" | "off" = "unset";
  let keepAliveSince: number | null = null;

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
    },
    setKeepAlive(enabled: boolean) {
      if (enabled) {
        keepAlive = "on";
        if (keepAliveSince == null) keepAliveSince = now();
      } else {
        keepAlive = "off";
        keepAliveSince = null;
      }
    },
    keepAliveEnabled() {
      return keepAlive === "on";
    },
    keepAliveState() {
      return keepAlive;
    },
    keepAliveExpired() {
      return keepAlive === "on" && keepAliveSince != null && now() - keepAliveSince >= keepAliveMaxTotalMs;
    },
    holdsOpen() {
      return this.isArmed() || keepAlive === "on";
    }
  };
}
