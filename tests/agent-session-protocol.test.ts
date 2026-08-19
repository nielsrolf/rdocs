import assert from "node:assert/strict";
import test from "node:test";

import { createAgentSessionState } from "../agent-core/session-protocol";

function stateWithClock(overrides?: Parameters<typeof createAgentSessionState>[0]) {
  let now = 1_000_000;
  const state = createAgentSessionState({ now: () => now, newToken: tokenSeq(), ...overrides });
  return { state, advance: (ms: number) => (now += ms), at: () => now };
}

function tokenSeq() {
  let n = 0;
  return () => `t${++n}`;
}

test("frames are sequenced and replayable from an arbitrary cursor", () => {
  const { state } = stateWithClock();

  assert.equal(state.status().phase, "awaiting_job");
  assert.equal(state.acceptJob({ input: {} }), true);
  assert.equal(state.status().phase, "running");

  const a = state.append({ type: "progress", event: { role: "assistant", message: "one" } });
  const b = state.append({ type: "progress", event: { role: "assistant", message: "two" } });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);

  const all = state.framesSince(0);
  assert.deepEqual(
    all.frames.map((f) => f.seq),
    [1, 2]
  );
  assert.equal(all.nextSeq, 2);
  assert.equal(all.done, false);

  // A host that already persisted frame 1 resumes without re-delivering it.
  const resumed = state.framesSince(1);
  assert.deepEqual(
    resumed.frames.map((f) => f.seq),
    [2]
  );
  assert.equal(resumed.nextSeq, 2);

  // An up-to-date cursor yields nothing and keeps pointing at the same place.
  const caughtUp = state.framesSince(2);
  assert.deepEqual(caughtUp.frames, []);
  assert.equal(caughtUp.nextSeq, 2);
});

test("a result frame makes the session terminal and is itself replayable", () => {
  const { state } = stateWithClock();
  state.acceptJob({});
  state.append({ type: "progress", event: { role: "assistant", message: "working" } });
  assert.equal(state.isTerminal(), false);

  state.append({ type: "result", output: { replacementText: "done" } });
  assert.equal(state.isTerminal(), true);
  assert.equal(state.status().phase, "terminal");

  // The whole point of the detached design: a process that attaches AFTER the
  // run finished still collects the outcome.
  const late = state.framesSince(0);
  assert.equal(late.done, true);
  assert.deepEqual(late.frames.at(-1)?.output, { replacementText: "done" });
});

test("an error frame is terminal too", () => {
  const { state } = stateWithClock();
  state.acceptJob({});
  state.append({ type: "error", message: "boom" });
  assert.equal(state.isTerminal(), true);
  assert.equal(state.framesSince(0).done, true);
});

test("attaching invalidates the previous attach token", () => {
  const { state } = stateWithClock();

  const first = state.attach();
  assert.equal(state.isCurrentToken(first.token), true);
  assert.equal(first.attachEpoch, 1);

  const second = state.attach();
  assert.equal(second.attachEpoch, 2);
  assert.notEqual(second.token, first.token);
  // The superseded reader must be rejected rather than racing the new one.
  assert.equal(state.isCurrentToken(first.token), false);
  assert.equal(state.isCurrentToken(second.token), true);
  assert.equal(state.isCurrentToken(null), false);
  assert.equal(state.isCurrentToken(""), false);
});

test("a re-attach resumes the existing job instead of starting a second one", () => {
  const { state } = stateWithClock();
  assert.equal(state.acceptJob({ input: { instruction: "first" } }), true);
  assert.equal(state.acceptJob({ input: { instruction: "second" } }), false);
  assert.deepEqual(state.job(), { input: { instruction: "first" } });
});

test("attach reports the cursor a re-attaching host should resume from", () => {
  const { state } = stateWithClock();
  state.acceptJob({});
  state.append({ type: "progress", event: { role: "assistant", message: "a" } });
  state.append({ type: "progress", event: { role: "assistant", message: "b" } });

  const attached = state.attach();
  assert.equal(attached.lastSeq, 2);
  assert.equal(attached.phase, "running");
});

test("frames evicted from the log are reported as a gap, never silently skipped", () => {
  const { state } = stateWithClock({ frameLimit: 3 });
  state.acceptJob({});
  for (let i = 0; i < 5; i += 1) {
    state.append({ type: "progress", event: { role: "assistant", message: `m${i}` } });
  }

  const status = state.status();
  assert.equal(status.lastSeq, 5);
  assert.equal(status.firstSeq, 3);

  const stale = state.framesSince(0);
  assert.equal(stale.droppedBefore, 3);
  assert.deepEqual(
    stale.frames.map((f) => f.seq),
    [3, 4, 5]
  );

  // A cursor inside the retained window is not a gap.
  assert.equal(state.framesSince(3).droppedBefore, undefined);
});

test("no host contact for the TTL expires the session (parent-death's replacement)", () => {
  const { state, advance } = stateWithClock({ noContactTtlMs: 10_000 });
  state.acceptJob({});
  assert.equal(state.expiredReason(), null);

  advance(9_000);
  assert.equal(state.expiredReason(), null);

  // A long-poll counts as contact, so an actively watched run never trips this.
  state.touch();
  advance(9_000);
  assert.equal(state.expiredReason(), null);

  advance(2_000);
  assert.equal(state.expiredReason(), "no-contact");
});

test("a finished session holds its result for the terminal hold, then expires", () => {
  const { state, advance } = stateWithClock({ terminalHoldMs: 5_000, noContactTtlMs: 60_000 });
  state.acceptJob({});
  state.append({ type: "result", output: {} });

  advance(4_000);
  assert.equal(state.expiredReason(), null);
  advance(2_000);
  assert.equal(state.expiredReason(), "terminal-hold");
});

test("the absolute lifetime ceiling wins over ongoing contact", () => {
  const { state, advance } = stateWithClock({ maxLifetimeMs: 20_000, noContactTtlMs: 60_000 });
  state.acceptJob({});
  for (let i = 0; i < 5; i += 1) {
    advance(5_000);
    state.touch();
  }
  assert.equal(state.expiredReason(), "max-lifetime");
});
