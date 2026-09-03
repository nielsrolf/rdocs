import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { createQuicktake } from "../lib/quicktakes";
import { slackDeliveryDisabledReason } from "../lib/slack/delivery";
import { createSlackWebClient } from "../lib/slack/web";

// Regression: `npm test` runs against the real database and calls real write
// paths, each of which fire-and-forgets a Slack DM. With .env sourced (how
// deploy.sh runs them) those DMs reached real people — fixture quicktake bodies
// showed up in Slack on 2026-09-02.

test("delivery is off under a test runner, and forceable either way", () => {
  assert.equal(slackDeliveryDisabledReason({ NODE_ENV: "production" }), null);
  assert.equal(slackDeliveryDisabledReason({ NODE_ENV: "test" }), "NODE_ENV=test");
  assert.equal(slackDeliveryDisabledReason({ NODE_TEST_CONTEXT: "child" }), "node:test runner");
  assert.equal(slackDeliveryDisabledReason({ npm_lifecycle_event: "test:integration" }), "npm run test:integration");
  assert.equal(slackDeliveryDisabledReason({ SLACK_NOTIFICATIONS_DISABLED: "1" }), "SLACK_NOTIFICATIONS_DISABLED=1");
  // An explicit 0 wins over the test-runner detection, for live smoke tests.
  assert.equal(slackDeliveryDisabledReason({ SLACK_NOTIFICATIONS_DISABLED: "0", NODE_ENV: "test" }), null);
});

test("posting a quick take in a test run sends nothing to slack.com", async (t) => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    calls.push(url);
    return realFetch(input, init);
  }) as typeof fetch;

  const previousToken = process.env.SLACK_BOT_TOKEN;
  // A token shaped like the real thing: the guard, not a missing credential,
  // has to be what stops the DM.
  process.env.SLACK_BOT_TOKEN = "xoxb-not-a-real-token";

  const author = await db.user.create({
    data: {
      email: `slack-guard-${crypto.randomUUID()}@example.com`,
      name: "slack-guard-author",
      passwordHash: "x"
    }
  });
  t.after(async () => {
    globalThis.fetch = realFetch;
    if (previousToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = previousToken;
    await db.document.deleteMany({ where: { ownerId: author.id } });
    await db.user.delete({ where: { id: author.id } });
  });

  const take = await createQuicktake(author.id, "guard fixture — must never reach Slack");
  assert.ok(take.id);
  // The notify call is fire-and-forget; give it room to do the damage.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(
    calls.filter((url) => url.includes("slack.com")),
    [],
    "a test run must not call the Slack API"
  );

  // The client itself is inert too, so any other path is covered as well.
  const result = await createSlackWebClient("xoxb-not-a-real-token").postMessage({
    channel: "U-nobody",
    text: "should not be delivered"
  });
  assert.deepEqual(result, { ts: null, channel: null });
  assert.deepEqual(calls.filter((url) => url.includes("slack.com")), []);
});
