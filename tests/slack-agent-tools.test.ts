import assert from "node:assert/strict";
import test from "node:test";

import { handleSlackAgentToolCall } from "../lib/slack/agent-tools";
import { createSlackToolsToken, verifySlackToolsToken } from "../lib/slack/link-token";
import type { SlackClient, SlackMessage } from "../lib/slack/web";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const BOT = "UBOT";

// C_BOTH: bot + alice + bob; C_ALICE: private, bot + alice only; C_NOBOT: alice only.
function makeSlack(): SlackClient {
  const membership: Record<string, string[]> = {
    C_BOTH: [BOT, "UALICE", "UBOB"],
    C_ALICE: [BOT, "UALICE"],
    C_NOBOT: ["UALICE"]
  };
  const history: Record<string, SlackMessage[]> = {
    C_BOTH: [{ ts: "1.0", user: "UALICE", text: "public plan" }],
    C_ALICE: [{ ts: "2.0", user: "UALICE", text: "secret plan" }]
  };
  return {
    async postMessage() {
      return { ts: null };
    },
    async postEphemeral() {},
    async addReaction() {},
    async removeReaction() {},
    async channelInfo() {
      return { name: "x" };
    },
    async userInfo(id) {
      return { displayName: `name-${id}` };
    },
    async threadReplies({ channel }) {
      return history[channel] ?? [];
    },
    async channelHistory({ channel }) {
      return history[channel] ?? [];
    },
    async botChannels() {
      return [
        { id: "C_BOTH", name: "both", isPrivate: false },
        { id: "C_ALICE", name: "alice-private", isPrivate: true }
      ];
    },
    async channelMembers(channelId) {
      const members = membership[channelId];
      if (!members) throw new Error("channel_not_found");
      return members;
    }
  };
}

const asBob = { slackTeamId: "T1", slackUserId: "UBOB", aiRunId: "run1" };
const asAlice = { slackTeamId: "T1", slackUserId: "UALICE", aiRunId: "run2" };

test("tools token round trip", async () => {
  const token = await createSlackToolsToken(asBob);
  assert.deepEqual(await verifySlackToolsToken(token), asBob);
  assert.equal(await verifySlackToolsToken(token + "x"), null);
});

test("list_slack_channels shows only channels both bot and requester are in", async () => {
  const slack = makeSlack();
  const bob = await handleSlackAgentToolCall(
    { tool: "list_slack_channels", args: {} },
    { claims: asBob, slack, botUserId: BOT }
  );
  assert.ok(bob.ok);
  assert.match(bob.text, /C_BOTH/);
  assert.doesNotMatch(bob.text, /C_ALICE/, "Bob must not see Alice's private channel");

  const alice = await handleSlackAgentToolCall(
    { tool: "list_slack_channels", args: {} },
    { claims: asAlice, slack, botUserId: BOT }
  );
  assert.match(alice.text, /C_ALICE/);
});

test("read_slack_channel denies non-members and channels without the bot", async () => {
  const slack = makeSlack();
  const denied = await handleSlackAgentToolCall(
    { tool: "read_slack_channel", args: { channel_id: "C_ALICE" } },
    { claims: asBob, slack, botUserId: BOT }
  );
  assert.equal(denied.ok, false);
  assert.match(denied.text, /not a member/);
  assert.doesNotMatch(denied.text, /secret plan/);

  const noBot = await handleSlackAgentToolCall(
    { tool: "read_slack_channel", args: { channel_id: "C_NOBOT" } },
    { claims: asAlice, slack, botUserId: BOT }
  );
  assert.equal(noBot.ok, false);
  assert.match(noBot.text, /bot is not a member/i);

  const allowed = await handleSlackAgentToolCall(
    { tool: "read_slack_channel", args: { channel_id: "C_ALICE" } },
    { claims: asAlice, slack, botUserId: BOT }
  );
  assert.ok(allowed.ok);
  assert.match(allowed.text, /name-UALICE: secret plan/);
});

test("read_slack_thread enforces the same rule and requires thread_ts", async () => {
  const slack = makeSlack();
  const missing = await handleSlackAgentToolCall(
    { tool: "read_slack_thread", args: { channel_id: "C_BOTH" } },
    { claims: asBob, slack, botUserId: BOT }
  );
  assert.equal(missing.ok, false);
  assert.match(missing.text, /thread_ts/);

  const denied = await handleSlackAgentToolCall(
    { tool: "read_slack_thread", args: { channel_id: "C_ALICE", thread_ts: "2.0" } },
    { claims: asBob, slack, botUserId: BOT }
  );
  assert.equal(denied.ok, false);

  const allowed = await handleSlackAgentToolCall(
    { tool: "read_slack_thread", args: { channel_id: "C_BOTH", thread_ts: "1.0" } },
    { claims: asBob, slack, botUserId: BOT }
  );
  assert.ok(allowed.ok);
  assert.match(allowed.text, /public plan/);
});
