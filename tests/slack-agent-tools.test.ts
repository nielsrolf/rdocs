import assert from "node:assert/strict";
import test from "node:test";

import { handleSlackAgentToolCall } from "../lib/slack/agent-tools";
import { createSlackToolsToken, verifySlackToolsToken } from "../lib/slack/link-token";
import type { SlackClient, SlackMessage } from "../lib/slack/web";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const BOT = "UBOT";

// C_BOTH: bot + alice + bob; C_ALICE: private, bot + alice only; C_NOBOT: alice only.
const uploads: Array<{ channel: string; threadTs?: string; filename: string; size: number }> = [];
const postedMessages: Array<{ channel: string; threadTs?: string; text: string }> = [];

let postedCounter = 0;

function makeSlack(): SlackClient {
  const membership: Record<string, string[]> = {
    C_BOTH: [BOT, "UALICE", "UBOB"],
    C_OTHER: [BOT, "UALICE", "UBOB"],
    C_ALICE: [BOT, "UALICE"],
    C_NOBOT: ["UALICE"]
  };
  const history: Record<string, SlackMessage[]> = {
    C_BOTH: [{ ts: "1.0", user: "UALICE", text: "public plan" }],
    C_ALICE: [{ ts: "2.0", user: "UALICE", text: "secret plan" }]
  };
  return {
    async postMessage(args) {
      postedMessages.push(args);
      postedCounter += 1;
      return { ts: `90${postedCounter}.0` };
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
    },
    async downloadFile() {
      return null;
    },
    async uploadFile(args) {
      uploads.push({ channel: args.channel, threadTs: args.threadTs, filename: args.filename, size: args.content.length });
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

test("recent_activity shows only runs on documents the requester can access", async (t) => {
  const crypto = await import("node:crypto");
  const { db } = await import("../lib/db");
  const teamId = `T-${crypto.randomUUID()}`;

  async function makeUser(name: string, slackId: string) {
    const user = await db.user.create({
      data: { email: `${name}-${crypto.randomUUID()}@example.com`, name, passwordHash: "x" }
    });
    await db.slackAccountLink.create({
      data: { slackTeamId: teamId, slackUserId: slackId, userId: user.id }
    });
    return user;
  }
  const alice = await makeUser("ra-alice", "UALICE");
  const bob = await makeUser("ra-bob", "UBOB");

  const aliceDoc = await db.document.create({
    data: { ownerId: alice.id, title: "Alice secret project", content: "{}" }
  });
  const sharedDoc = await db.document.create({
    data: { ownerId: alice.id, title: "Shared roadmap", content: "{}" }
  });
  await db.documentMembership.create({
    data: { documentId: sharedDoc.id, userId: bob.id, permission: "EDIT" }
  });
  await db.aiRun.create({
    data: {
      documentId: aliceDoc.id,
      triggerType: "CONVERSATION",
      createdById: alice.id,
      instruction: "analyze the secret data",
      status: "SUCCEEDED",
      progress: "Found the secret answer."
    }
  });
  await db.aiRun.create({
    data: {
      documentId: sharedDoc.id,
      triggerType: "CONVERSATION",
      createdById: alice.id,
      instruction: "update the roadmap",
      status: "SUCCEEDED",
      progress: "Roadmap updated."
    }
  });

  const slack = makeSlack();
  const asBobHere = { slackTeamId: teamId, slackUserId: "UBOB", aiRunId: "r1" };
  const bobView = await handleSlackAgentToolCall(
    { tool: "recent_activity", args: {} },
    { claims: asBobHere, slack, botUserId: BOT }
  );
  assert.ok(bobView.ok);
  assert.match(bobView.text, /Shared roadmap/);
  assert.match(bobView.text, /update the roadmap/);
  assert.match(bobView.text, /ra-alice/, "attribution shows who triggered the run");
  assert.doesNotMatch(bobView.text, /secret/, "Bob must not see Alice-only runs");

  const asAliceHere = { slackTeamId: teamId, slackUserId: "UALICE", aiRunId: "r2" };
  const aliceView = await handleSlackAgentToolCall(
    { tool: "recent_activity", args: { project: "secret" } },
    { claims: asAliceHere, slack, botUserId: BOT }
  );
  assert.match(aliceView.text, /analyze the secret data/);
  assert.match(aliceView.text, /outcome: Found the secret answer/);
  assert.doesNotMatch(aliceView.text, /Shared roadmap/, "project filter scopes the feed");

  const unlinked = await handleSlackAgentToolCall(
    { tool: "recent_activity", args: {} },
    { claims: { slackTeamId: teamId, slackUserId: "UNOBODY", aiRunId: "r3" }, slack, botUserId: BOT }
  );
  assert.equal(unlinked.ok, false);
});

test("run-scoped slack token authenticates the MCP bridge as the linked user", async () => {
  const crypto = await import("node:crypto");
  const { db } = await import("../lib/db");
  const { createSlackToolsToken: mkToken } = await import("../lib/slack/link-token");
  const { handleMcpMessage } = await import("../lib/mcp/server");
  const teamId = `T-${crypto.randomUUID()}`;

  const user = await db.user.create({
    data: { email: `mcp-slack-${crypto.randomUUID()}@example.com`, name: "mcp-slack", passwordHash: "x" }
  });
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "UMCP", userId: user.id }
  });
  const doc = await db.document.create({
    data: {
      ownerId: user.id,
      title: "My slack-reachable doc",
      content: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] })
    }
  });

  // Exercise the exact resolution path the route uses.
  const routeModule = await import("../app/api/mcp/route");
  const token = await mkToken({ slackTeamId: teamId, slackUserId: "UMCP", aiRunId: "r-mcp" });
  const request = new Request("http://localhost:14141/api/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_documents", arguments: {} } })
  });
  const response = await routeModule.POST(request);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { result?: { content: Array<{ text: string }> } };
  assert.ok(payload.result, "tools/call must succeed with the slack run token");
  assert.match(payload.result!.content[0].text, /My slack-reachable doc/);

  // A garbage token is still rejected.
  const bad = await routeModule.POST(
    new Request("http://localhost:14141/api/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer not-a-token", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    })
  );
  assert.equal(bad.status, 401);
  void handleMcpMessage;
  void doc;
});

test("send_file uploads into the run's own thread after a membership check", async () => {
  const crypto = await import("node:crypto");
  const { db } = await import("../lib/db");
  const teamId = `T-${crypto.randomUUID()}`;
  const user = await db.user.create({
    data: { email: `sf-${crypto.randomUUID()}@example.com`, name: "sf", passwordHash: "x" }
  });
  const doc = await db.document.create({ data: { ownerId: user.id, title: "x", content: "{}" } });
  const run = await db.aiRun.create({
    data: { documentId: doc.id, triggerType: "SLACK_MENTION", triggerId: "C_BOTH:1.0", instruction: "x" }
  });
  const slack = makeSlack();
  const before = uploads.length;
  const ok = await handleSlackAgentToolCall(
    {
      tool: "send_file",
      args: { filename: "plot.png", content_base64: Buffer.from("png-bytes").toString("base64") }
    },
    { claims: { slackTeamId: teamId, slackUserId: "UALICE", aiRunId: run.id }, slack, botUserId: BOT }
  );
  assert.ok(ok.ok, ok.text);
  assert.equal(uploads.length, before + 1);
  assert.deepEqual(uploads.at(-1), { channel: "C_BOTH", threadTs: "1.0", filename: "plot.png", size: 9 });

  // A run anchored in a channel the requester is not a member of is refused.
  const runPrivate = await db.aiRun.create({
    data: { documentId: doc.id, triggerType: "SLACK_MENTION", triggerId: "C_ALICE:2.0", instruction: "x" }
  });
  const denied = await handleSlackAgentToolCall(
    { tool: "send_file", args: { filename: "p.png", content_base64: "eA==" } },
    { claims: { slackTeamId: teamId, slackUserId: "UBOB", aiRunId: runPrivate.id }, slack, botUserId: BOT }
  );
  assert.equal(denied.ok, false);
});

// The alternative to check_back_later is an agent that babysits a long job with
// sleep/poll loops — it burns context, and the turn dies with the run. This tool
// must create a one-shot wake-up in the SAME thread, without the "⏰ Scheduled
// task created" consent announcement (it is a self-alarm inside a conversation
// everyone in the thread already sees, not a new standing job).
test("check_back_later schedules a silent one-shot wake-up in the run's own thread", async () => {
  const crypto = await import("node:crypto");
  const { db } = await import("../lib/db");
  const teamId = `T-${crypto.randomUUID()}`;
  const user = await db.user.create({
    data: { email: `cbl-${crypto.randomUUID()}@example.com`, name: "cbl", passwordHash: "x" }
  });
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "UALICE", userId: user.id }
  });
  const doc = await db.document.create({ data: { ownerId: user.id, title: "cbl doc", content: "{}" } });
  const run = await db.aiRun.create({
    data: { documentId: doc.id, triggerType: "SLACK_MENTION", triggerId: "C_BOTH:1.0", instruction: "x" }
  });
  const claims = { slackTeamId: teamId, slackUserId: "UALICE", aiRunId: run.id };
  const slack = makeSlack();

  const before = postedMessages.length;
  const result = await handleSlackAgentToolCall(
    {
      tool: "check_back_later",
      args: { after_minutes: 20, instruction: "Check tail -50 /tmp/train.log; if done, report the eval numbers." }
    },
    { claims, slack, botUserId: BOT }
  );
  assert.ok(result.ok, result.text);
  assert.match(result.text, /end your turn/i, "the result tells the agent to stop working now");
  assert.equal(postedMessages.length, before, "no consent announcement for a self-alarm");

  const tasks = await db.scheduledTask.findMany({ where: { documentId: doc.id, disabledAt: null } });
  assert.equal(tasks.length, 1);
  const task = tasks[0];
  assert.equal(task.cron, null, "one-shot, not recurring");
  assert.equal(task.contextType, "slack_thread");
  assert.equal(task.slackChannelId, "C_BOTH");
  assert.equal(task.slackThreadTs, "1.0", "wakes up in the same thread");
  assert.equal(task.createdByRunId, run.id);
  assert.match(task.instruction, /train\.log/);
  const deltaMinutes = (task.nextRunAt.getTime() - Date.now()) / 60000;
  assert.ok(deltaMinutes > 18 && deltaMinutes < 22, `fires in ~20 minutes (got ${deltaMinutes})`);

  // Both arguments are required, and the delay is clamped to a sane window.
  const noInstruction = await handleSlackAgentToolCall(
    { tool: "check_back_later", args: { after_minutes: 5 } },
    { claims, slack, botUserId: BOT }
  );
  assert.equal(noInstruction.ok, false);
  assert.match(noInstruction.text, /instruction/);

  const tooLong = await handleSlackAgentToolCall(
    { tool: "check_back_later", args: { after_minutes: 99999, instruction: "check" } },
    { claims, slack, botUserId: BOT }
  );
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.text, /after_minutes/);
});

test("post_slack_message posts only into the run's own thread", async () => {
  const crypto = await import("node:crypto");
  const { db } = await import("../lib/db");
  const user = await db.user.create({
    data: { email: `psm-${crypto.randomUUID()}@example.com`, name: "psm", passwordHash: "x" }
  });
  const doc = await db.document.create({ data: { ownerId: user.id, title: "x", content: "{}" } });
  const run = await db.aiRun.create({
    data: { documentId: doc.id, triggerType: "SLACK_MENTION", triggerId: "C_BOTH:1.0", instruction: "x" }
  });
  const before = postedMessages.length;
  const result = await handleSlackAgentToolCall(
    { tool: "post_slack_message", args: { text: "**Update**: checking another thread" } },
    {
      claims: { slackTeamId: "T1", slackUserId: "UALICE", aiRunId: run.id },
      slack: makeSlack(),
      botUserId: BOT
    }
  );
  assert.equal(result.ok, true);
  assert.equal(postedMessages.length, before + 1);
  assert.deepEqual(postedMessages.at(-1), {
    channel: "C_BOTH",
    threadTs: "1.0",
    text: "*Update*: checking another thread"
  });
});

// message_thread is the supervisor capability: the agent in one thread drives the
// agent working in ANOTHER thread by delivering a message that is treated exactly
// like a human Slack message there (steer the live run, else start a new one).
// It must not weaken the read-tool membership rule, and must not be usable to
// talk to itself (that is what submit_response / post_slack_message are for).
async function messageThreadFixture(prefix: string) {
  const crypto = await import("node:crypto");
  const { db } = await import("../lib/db");
  const teamId = `T-${crypto.randomUUID()}`;
  const user = await db.user.create({
    data: { email: `${prefix}-${crypto.randomUUID()}@example.com`, name: prefix, passwordHash: "x" }
  });
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "UBOB", userId: user.id }
  });
  const channelDoc = await db.document.create({
    data: {
      ownerId: user.id,
      kind: "slack_channel",
      slackTeamId: teamId,
      slackChannelId: "C_BOTH",
      title: "#both",
      content: "{}"
    }
  });
  const callerRun = await db.aiRun.create({
    data: {
      documentId: channelDoc.id,
      triggerType: "SLACK_MENTION",
      triggerId: "C_BOTH:1.0",
      instruction: "supervise",
      status: "SUCCEEDED"
    }
  });
  return {
    db,
    teamId,
    user,
    channelDoc,
    callerRun,
    claims: { slackTeamId: teamId, slackUserId: "UBOB", aiRunId: callerRun.id }
  };
}

test("message_thread refuses empty text, its own thread, and unreadable channels", async () => {
  const { claims } = await messageThreadFixture("mt-deny");
  const slack = makeSlack();
  const before = postedMessages.length;

  const empty = await handleSlackAgentToolCall(
    { tool: "message_thread", args: { channel_id: "C_BOTH", thread_ts: "9.9", text: "   " } },
    { claims, slack, botUserId: BOT }
  );
  assert.equal(empty.ok, false);
  assert.match(empty.text, /text is required/);

  const own = await handleSlackAgentToolCall(
    { tool: "message_thread", args: { channel_id: "C_BOTH", thread_ts: "1.0", text: "hello me" } },
    { claims, slack, botUserId: BOT }
  );
  assert.equal(own.ok, false);
  assert.match(own.text, /own conversation/i);

  // Same channel, no thread_ts: also the caller's own conversation surface.
  const ownChannel = await handleSlackAgentToolCall(
    { tool: "message_thread", args: { channel_id: "C_BOTH", text: "hello me" } },
    { claims, slack, botUserId: BOT }
  );
  assert.equal(ownChannel.ok, false);

  // Bob is not in Alice's private channel — same rule as the read tools.
  const denied = await handleSlackAgentToolCall(
    { tool: "message_thread", args: { channel_id: "C_ALICE", thread_ts: "2.0", text: "do my bidding" } },
    { claims, slack, botUserId: BOT }
  );
  assert.equal(denied.ok, false);
  assert.match(denied.text, /not a member/);

  assert.equal(postedMessages.length, before, "a refused message_thread must not post anything to Slack");
});

test("message_thread steers a live run in the target thread", async () => {
  const { db, channelDoc, claims } = await messageThreadFixture("mt-steer");
  const targetRun = await db.aiRun.create({
    data: {
      documentId: channelDoc.id,
      triggerType: "SLACK_MENTION",
      triggerId: "C_BOTH:9.9",
      instruction: "work on the migration",
      status: "RUNNING"
    }
  });
  const injected: Array<{ aiRunId: string; text: string }> = [];
  const slack = makeSlack();
  const before = postedMessages.length;

  const result = await handleSlackAgentToolCall(
    { tool: "message_thread", args: { channel_id: "C_BOTH", thread_ts: "9.9", text: "the build is fixed, retry it" } },
    {
      claims,
      slack,
      botUserId: BOT,
      startRun: async () => {
        throw new Error("must steer the live run instead of starting a new one");
      },
      injectRunMessage: (aiRunId, text) => {
        injected.push({ aiRunId, text });
        return true;
      }
    }
  );
  assert.ok(result.ok, result.text);
  assert.match(result.text, /steer/i);
  assert.deepEqual(
    injected.map((i) => i.aiRunId),
    [targetRun.id]
  );
  assert.match(injected[0].text, /still working/i, "delivered with the steering framing");
  assert.match(injected[0].text, /the build is fixed, retry it/);

  // Visible in Slack, attributed to the originating conversation.
  assert.equal(postedMessages.length, before + 1);
  const posted = postedMessages.at(-1)!;
  assert.equal(posted.channel, "C_BOTH");
  assert.equal(posted.threadTs, "9.9");
  assert.match(posted.text, /the build is fixed, retry it/);
  assert.match(posted.text, /#x|C_BOTH/, "names where the message came from");

  const events = await db.aiRunEvent.findMany({ where: { aiRunId: targetRun.id } });
  assert.ok(
    events.some((event) => event.message.includes("the build is fixed, retry it")),
    "the steered run's timeline records the incoming message"
  );

  await db.aiRun.update({ where: { id: targetRun.id }, data: { status: "FAILED", error: "test cleanup" } });
});

test("message_thread starts a new run when the target thread is idle", async () => {
  const { db, channelDoc, claims } = await messageThreadFixture("mt-start");
  const started: Array<{ documentId: string; aiRunId: string; message: string }> = [];
  const slack = makeSlack();

  const inThread = await handleSlackAgentToolCall(
    { tool: "message_thread", args: { channel_id: "C_BOTH", thread_ts: "7.7", text: "please review PR 12" } },
    {
      claims,
      slack,
      botUserId: BOT,
      startRun: async (input) => {
        started.push({ documentId: input.documentId, aiRunId: input.aiRunId, message: input.message });
      },
      injectRunMessage: () => false
    }
  );
  assert.ok(inThread.ok, inThread.text);
  assert.match(inThread.text, /started/i);
  assert.equal(started.length, 1);
  assert.equal(started[0].documentId, channelDoc.id);
  assert.match(started[0].message, /please review PR 12/);
  const threadRun = await db.aiRun.findUnique({ where: { id: started[0].aiRunId } });
  assert.equal(threadRun?.triggerId, "C_BOTH:7.7");
  assert.equal(threadRun?.triggerType, "SLACK_MENTION");
  assert.equal(postedMessages.at(-1)?.threadTs, "7.7");

  // No thread_ts: a fresh top-level message in another channel becomes the thread.
  const topLevel = await handleSlackAgentToolCall(
    { tool: "message_thread", args: { channel_id: "C_OTHER", text: "kick off the nightly eval" } },
    {
      claims,
      slack,
      botUserId: BOT,
      startRun: async (input) => {
        started.push({ documentId: input.documentId, aiRunId: input.aiRunId, message: input.message });
      },
      injectRunMessage: () => false
    }
  );
  assert.ok(topLevel.ok, topLevel.text);
  assert.match(topLevel.text, /started/i);
  assert.equal(started.length, 2);
  const postedTop = postedMessages.at(-1)!;
  assert.equal(postedTop.channel, "C_OTHER");
  assert.equal(postedTop.threadTs, undefined, "a new conversation is a top-level message");
  const topRun = await db.aiRun.findUnique({ where: { id: started[1].aiRunId } });
  assert.match(topRun!.triggerId!, /^C_OTHER:9\d+\.0$/, "the posted message's ts becomes the conversation key");
  assert.notEqual(topRun?.documentId, channelDoc.id, "another channel gets its own channel document");

  for (const entry of started) {
    await db.aiRun.update({ where: { id: entry.aiRunId }, data: { status: "FAILED", error: "test cleanup" } });
  }
});
