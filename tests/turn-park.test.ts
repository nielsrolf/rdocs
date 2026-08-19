import assert from "node:assert/strict";
import test from "node:test";

import { createAgentInputChannel } from "../agent-core/input-channel";
import {
  buildBackgroundWorkQuestion,
  createTurnPark,
  KEEP_ALIVE_MAX_TOTAL_MS,
  KEEP_ALIVE_RECHECK_MS,
  KEEP_ALIVE_RECHECK_NUDGE,
  MAX_KEEP_ALIVE_MINUTES,
  PARK_GRACE_MS,
  PARK_TIMEOUT_NUDGE
} from "../agent-core/turn-park";

test("a park armed within the keep-alive limit holds until its deadline", () => {
  let now = 1_000_000;
  const park = createTurnPark({ now: () => now, maxKeepAliveMinutes: 120, graceMs: 60_000 });

  assert.equal(park.isArmed(), false);
  assert.equal(park.remainingMs(), 0);

  assert.equal(park.arm(10), true);
  assert.equal(park.isArmed(), true);
  assert.equal(park.deadlineMs(), 1_000_000 + 10 * 60_000 + 60_000);

  now += 10 * 60_000; // the wake-up is due but has not arrived yet
  assert.equal(park.isArmed(), true, "grace keeps the session alive past the nominal wake-up");
  assert.equal(park.remainingMs(), 60_000);

  now += 60_001;
  assert.equal(park.isArmed(), false, "past the deadline the park no longer holds the turn open");
  assert.equal(park.remainingMs(), 0);
});

test("waits longer than the keep-alive limit refuse to park", () => {
  const park = createTurnPark({ maxKeepAliveMinutes: 120 });
  // Holding an idle container for hours pins a blue/green drain; those waits
  // keep the historical detach-and-die semantics instead.
  assert.equal(park.arm(121), false);
  assert.equal(park.isArmed(), false);
  // Nonsense delays must not park either (the tool clamps 1..1440).
  assert.equal(park.arm(0), false);
  assert.equal(park.arm(-5), false);
  assert.equal(park.arm(Number.NaN), false);
  assert.equal(park.isArmed(), false);
});

test("disarm releases the turn so the next result frame ends the run", () => {
  const park = createTurnPark();
  assert.equal(park.arm(5), true);
  park.disarm();
  assert.equal(park.isArmed(), false);
  assert.equal(park.deadlineMs(), null);
});

test("a parked channel stays open for the wake-up and only then ends the session", async () => {
  // This is the whole point of parking: after the turn's result frame the
  // steering channel is NOT closed, so the SDK session (and, in a container run,
  // PID 1 with the mounted worktree and every background process the agent
  // started) is still alive when the scheduler injects the wake-up.
  const channel = createAgentInputChannel();
  const park = createTurnPark();

  const delivered: string[] = [];
  const consumer = (async () => {
    for await (const text of channel) {
      park.disarm();
      delivered.push(text);
    }
  })();

  assert.equal(park.arm(3), true);

  // Result frame with nothing pending: parked, so the host leaves it open.
  assert.equal(channel.pendingCount(), 0);
  if (!park.isArmed()) channel.close();
  assert.equal(channel.isClosed(), false, "an armed park must not close the input channel");

  // The wake-up arrives as a normal injected user message.
  assert.equal(channel.push("[Scheduled task firing] check the job"), true);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(delivered, ["[Scheduled task firing] check the job"]);
  assert.equal(park.isArmed(), false, "delivery disarms the park");

  channel.close();
  await consumer;
});

test("if the wake-up never arrives the agent is nudged instead of idling forever", async () => {
  const channel = createAgentInputChannel();
  const delivered: string[] = [];
  const consumer = (async () => {
    for await (const text of channel) delivered.push(text);
  })();

  // What the host timer does at the park deadline.
  assert.equal(channel.push(PARK_TIMEOUT_NUDGE), true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /submit_response/, "the nudge tells the agent to finish the turn");

  channel.close();
  await consumer;
});

test("keep-alive bounds stay sane", () => {
  assert.ok(MAX_KEEP_ALIVE_MINUTES > 0 && MAX_KEEP_ALIVE_MINUTES <= 1440);
  assert.ok(PARK_GRACE_MS > 0);
  assert.ok(KEEP_ALIVE_RECHECK_MS >= 5 * 60_000, "rechecks must not spam the session");
  assert.ok(KEEP_ALIVE_MAX_TOTAL_MS > KEEP_ALIVE_RECHECK_MS, "TTL must allow at least one recheck");
});

// --- keep_alive_after_turn: state-based session lifetime ---

test("keep-alive survives message delivery (the 2026-08-10 regression)", async () => {
  // Incident shape: agent parks with an alarm, user asks "how is it going?",
  // delivery disarms the alarm, the agent replies WITHOUT re-arming, and the
  // reply turn's result frame ends the run — killing the background sweep.
  // With keep-alive ON the channel must stay open through that exact sequence.
  const channel = createAgentInputChannel();
  const park = createTurnPark();

  const delivered: string[] = [];
  const consumer = (async () => {
    for await (const text of channel) {
      park.disarm(); // what the steering wrapper does — alarm only
      delivered.push(text);
    }
  })();

  park.setKeepAlive(true);
  assert.equal(park.arm(6), true);

  // Mid-park user message: alarm gone after delivery, keep-alive NOT.
  channel.push("How is it going?");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(park.isArmed(), false, "delivery disarms the alarm");
  assert.equal(park.keepAliveEnabled(), true, "delivery must not clear keep-alive");

  // Result frame of the reply turn: keep-alive still holds the channel open.
  assert.equal(park.holdsOpen(), true);
  if (!park.holdsOpen()) channel.close();
  assert.equal(channel.isClosed(), false, "the reply turn must not end a kept-alive session");

  // Only the agent's explicit decision releases it.
  park.setKeepAlive(false);
  assert.equal(park.holdsOpen(), false);
  channel.close();
  await consumer;
});

test("keep-alive is tri-state so the host asks about background work at most once", () => {
  const park = createTurnPark();
  assert.equal(park.keepAliveState(), "unset");
  park.setKeepAlive(false);
  assert.equal(park.keepAliveState(), "off", "an explicit no is remembered — never re-ask");
  park.setKeepAlive(true);
  assert.equal(park.keepAliveState(), "on");
  assert.equal(park.keepAliveEnabled(), true);
});

test("keep-alive expires at the absolute TTL", () => {
  let now = 0;
  const park = createTurnPark({ now: () => now, keepAliveMaxTotalMs: 60_000 });
  park.setKeepAlive(true);
  assert.equal(park.keepAliveExpired(), false);
  now += 59_999;
  assert.equal(park.keepAliveExpired(), false);
  now += 1;
  assert.equal(park.keepAliveExpired(), true);
  // Toggling off and on resets the clock — a fresh decision earns fresh time.
  park.setKeepAlive(false);
  park.setKeepAlive(true);
  assert.equal(park.keepAliveExpired(), false);
});

test("the recheck nudge asks the agent to confirm, not to submit blindly", () => {
  assert.match(KEEP_ALIVE_RECHECK_NUDGE, /keep_alive_after_turn/);
  assert.match(KEEP_ALIVE_RECHECK_NUDGE, /enabled=false/);
});

test("the background-work question lists the work and all three ways out", () => {
  const question = buildBackgroundWorkQuestion(["background Bash: python train.py", "process 42: node server.js"]);
  assert.match(question, /python train\.py/);
  assert.match(question, /node server\.js/);
  assert.match(question, /check_back_later/);
  assert.match(question, /keep_alive_after_turn/);
  assert.match(question, /enabled=false/);
});
