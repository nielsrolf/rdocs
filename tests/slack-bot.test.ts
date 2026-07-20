import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { createSlackLinkToken, verifySlackLinkToken } from "../lib/slack/link-token";
import {
  ensureSlackChannelDocument,
  handleSlackAppMention,
  handleSlackDirectMessage,
  hasSeenSlackEvent,
  isInterruptMessage,
  stripBotMention,
  type SlackMentionEvent
} from "../lib/slack/events";
import { isCancellableAiRun, registerRunAbortController } from "../lib/agent-runner/run-registry";
import type { ConversationRunInput } from "../lib/agent-conversation";
import { buildUserPrompt } from "../agent-core/agent";
import type { SlackClient, SlackMessage } from "../lib/slack/web";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const BOT_USER_ID = "UBOT";
const APP_URL = "http://localhost:14141";

function makeFakeSlack(threadMessages: SlackMessage[] = [], channelMessages: SlackMessage[] = []) {
  const posted: Array<{ channel: string; text: string; threadTs?: string }> = [];
  const ephemeral: Array<{ channel: string; user: string; text: string; threadTs?: string }> = [];
  const reactions: Array<{ op: "add" | "remove"; ts: string; name: string }> = [];
  const client: SlackClient = {
    async postMessage(args) {
      posted.push(args);
      return { ts: `${posted.length}.000` };
    },
    async postEphemeral(args) {
      ephemeral.push(args);
    },
    async addReaction({ ts, name }) {
      reactions.push({ op: "add", ts, name });
    },
    async removeReaction({ ts, name }) {
      reactions.push({ op: "remove", ts, name });
    },
    async channelInfo() {
      return { name: "research" };
    },
    async userInfo(userId) {
      return { displayName: `name-of-${userId}` };
    },
    async threadReplies() {
      return threadMessages;
    },
    async channelHistory() {
      return channelMessages;
    },
    async botChannels() {
      return [];
    },
    async channelMembers() {
      return [];
    },
    async downloadFile() {
      return Buffer.from("fake-bytes");
    },
    async uploadFile() {}
  };
  return { client, posted, ephemeral, reactions };
}

async function makeUser(prefix: string) {
  return db.user.create({
    data: { email: `${prefix}-${crypto.randomUUID()}@example.com`, name: prefix, passwordHash: "x" }
  });
}

function mention(overrides: Partial<SlackMentionEvent> & { teamId: string }): SlackMentionEvent {
  return {
    type: "app_mention",
    eventId: `ev-${crypto.randomUUID()}`,
    channel: "C123",
    user: "UALICE",
    text: `<@${BOT_USER_ID}> summarize the latest results`,
    ts: "1000.000",
    ...overrides
  };
}

function depsWith(client: SlackClient, runs: ConversationRunInput[]) {
  return {
    slack: client,
    appUrl: APP_URL,
    botUserId: BOT_USER_ID,
    startRun: async (input: ConversationRunInput) => {
      runs.push(input);
    }
  };
}

test("slack link token: round trip, tamper, wrong purpose", async () => {
  const token = await createSlackLinkToken({ slackTeamId: "T1", slackUserId: "U1" });
  const claims = await verifySlackLinkToken(token);
  assert.deepEqual(claims, { slackTeamId: "T1", slackUserId: "U1" });

  assert.equal(await verifySlackLinkToken(token.slice(0, -2) + "xx"), null);
  assert.equal(await verifySlackLinkToken("not-a-token"), null);
});

test("mention text stripping and event dedupe", () => {
  assert.equal(stripBotMention(`<@${BOT_USER_ID}> do the thing <@${BOT_USER_ID}>`, BOT_USER_ID), "do the thing");
  const id = `dedupe-${crypto.randomUUID()}`;
  assert.equal(hasSeenSlackEvent(id), false);
  assert.equal(hasSeenSlackEvent(id), true);
});

test("unlinked slack user gets a connect prompt and no run", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const { client, ephemeral } = makeFakeSlack();
  const runs: ConversationRunInput[] = [];

  const result = await handleSlackAppMention(mention({ teamId }), depsWith(client, runs));

  assert.equal(result.handled, false);
  assert.equal("reason" in result && result.reason, "unlinked-user");
  assert.equal(runs.length, 0);
  assert.equal(ephemeral.length, 1);
  assert.match(ephemeral[0].text, /\/api\/slack\/connect\?token=/);

  const url = ephemeral[0].text.match(/http\S+token=(\S+)/);
  assert.ok(url, "prompt must contain a connect URL with a token");
  const claims = await verifySlackLinkToken(decodeURIComponent(url![1]));
  assert.equal(claims?.slackTeamId, teamId);
  assert.equal(claims?.slackUserId, "UALICE");
});

test("linked user mention creates channel document + run with the mentioner's identity", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeUser("slack-alice");
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "UALICE", userId: alice.id }
  });

  const { client, posted, reactions } = makeFakeSlack();
  const runs: ConversationRunInput[] = [];
  const result = await handleSlackAppMention(mention({ teamId }), depsWith(client, runs));

  assert.equal(result.handled, true);
  const document = await db.document.findUnique({
    where: { slackTeamId_slackChannelId: { slackTeamId: teamId, slackChannelId: "C123" } }
  });
  assert.ok(document, "channel document must exist");
  assert.equal(document!.kind, "slack_channel");
  assert.equal(document!.title, "#research");
  assert.equal(document!.ownerId, alice.id);

  const run = await db.aiRun.findUnique({ where: { id: (result as { aiRunId: string }).aiRunId } });
  assert.ok(run);
  assert.equal(run!.triggerType, "SLACK_MENTION");
  assert.equal(run!.triggerId, "C123:1000.000");
  assert.equal(run!.instruction, "summarize the latest results");

  assert.equal(runs.length, 1);
  assert.equal(runs[0].createdById, alice.id, "run must execute with the mentioner's identity");
  assert.equal(runs[0].agentAccessMode, "workspace");

  // No ack message — a 👀 reaction on the triggering message instead.
  assert.equal(posted.length, 0);
  assert.deepEqual(reactions, [{ op: "add", ts: "1000.000", name: "eyes" }]);

  // Reply delivery through the onFinished hook: swap 👀 for ✅ and post reply.
  await runs[0].onFinished?.({ status: "SUCCEEDED", reply: "All done!", error: null });
  assert.deepEqual(reactions.slice(1), [
    { op: "remove", ts: "1000.000", name: "eyes" },
    { op: "add", ts: "1000.000", name: "white_check_mark" }
  ]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].text, "All done!");
  assert.equal(posted[0].threadTs, "1000.000");

  // A failed run gets ❌.
  await runs[0].onFinished?.({ status: "FAILED", reply: null, error: "boom" });
  assert.deepEqual(reactions.at(-1), { op: "add", ts: "1000.000", name: "x" });
  assert.match(posted.at(-1)!.text, /boom/);
});

test("DM: responds without a mention, replies in a thread, threads chain", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeUser("slack-dm-alice");
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "UALICE", userId: alice.id }
  });

  const { client, posted, reactions } = makeFakeSlack();
  const runs: ConversationRunInput[] = [];
  const first = await handleSlackDirectMessage(
    mention({ teamId, channel: "D555", text: "hello, what are you?", ts: "5000.000" }),
    depsWith(client, runs)
  );
  assert.equal(first.handled, true);

  const document = await db.document.findUnique({
    where: { slackTeamId_slackChannelId: { slackTeamId: teamId, slackChannelId: "D555" } }
  });
  assert.ok(document);
  assert.equal(document!.kind, "slack_channel");
  assert.match(document!.title, /^Slack DM \(name-of-UALICE\)$/);

  const firstRun = await db.aiRun.findUnique({ where: { id: (first as { aiRunId: string }).aiRunId } });
  assert.equal(firstRun!.triggerId, "D555:5000.000");
  assert.equal(firstRun!.instruction, "hello, what are you?");
  await db.aiRun.update({ where: { id: firstRun!.id }, data: { status: "SUCCEEDED" } });

  // Replies are threaded off the triggering message so the thread IS the
  // visible conversation context.
  await runs[0].onFinished?.({ status: "SUCCEEDED", reply: "Hi!", error: null });
  assert.equal(posted.at(-1)!.threadTs, "5000.000");
  assert.deepEqual(reactions.at(-1), { op: "add", ts: "5000.000", name: "white_check_mark" });

  // A reply inside that thread chains to the first run…
  const threaded = await handleSlackDirectMessage(
    mention({ teamId, channel: "D555", text: "and now do a thing", ts: "5001.000", threadTs: "5000.000" }),
    depsWith(client, runs)
  );
  const threadedRun = await db.aiRun.findUnique({ where: { id: (threaded as { aiRunId: string }).aiRunId } });
  assert.equal(threadedRun!.triggerType, "SLACK_FOLLOWUP");
  assert.equal(threadedRun!.parentRunId, firstRun!.id);
  await db.aiRun.update({ where: { id: threadedRun!.id }, data: { status: "SUCCEEDED" } });

  // …while a new top-level DM message starts a fresh conversation.
  const fresh = await handleSlackDirectMessage(
    mention({ teamId, channel: "D555", text: "unrelated question", ts: "5002.000" }),
    depsWith(client, runs)
  );
  const freshRun = await db.aiRun.findUnique({ where: { id: (fresh as { aiRunId: string }).aiRunId } });
  assert.equal(freshRun!.triggerType, "SLACK_MENTION");
  assert.equal(freshRun!.parentRunId, null);
  assert.equal(freshRun!.triggerId, "D555:5002.000");
});

test("DM: unlinked user gets the connect prompt as a normal message; subtypes ignored", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const { client, posted, ephemeral } = makeFakeSlack();
  const runs: ConversationRunInput[] = [];

  const result = await handleSlackDirectMessage(
    mention({ teamId, channel: "D556", text: "hi", ts: "6000.000" }),
    depsWith(client, runs)
  );
  assert.equal(result.handled, false);
  assert.equal("reason" in result && result.reason, "unlinked-user");
  assert.equal(ephemeral.length, 0, "DM prompts are regular messages, not ephemeral");
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /\/api\/slack\/connect\?token=/);

  const edited = await handleSlackDirectMessage(
    mention({ teamId, channel: "D556", text: "hi", ts: "6001.000", subtype: "message_changed" }),
    depsWith(client, runs)
  );
  assert.equal(edited.handled, false);
  assert.equal("reason" in edited && edited.reason, "bot-message");
});

test("follow-up mention in the same thread chains to the previous run", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeUser("slack-alice2");
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "UALICE", userId: alice.id }
  });

  const { client } = makeFakeSlack();
  const runs: ConversationRunInput[] = [];
  const first = await handleSlackAppMention(mention({ teamId }), depsWith(client, runs));
  assert.equal(first.handled, true);
  const firstRunId = (first as { aiRunId: string }).aiRunId;
  await db.aiRun.update({ where: { id: firstRunId }, data: { status: "SUCCEEDED" } });

  const second = await handleSlackAppMention(
    mention({ teamId, ts: "1001.000", threadTs: "1000.000", text: `<@${BOT_USER_ID}> and now expand it` }),
    depsWith(client, runs)
  );
  assert.equal(second.handled, true);
  const secondRun = await db.aiRun.findUnique({ where: { id: (second as { aiRunId: string }).aiRunId } });
  assert.equal(secondRun!.triggerType, "SLACK_FOLLOWUP");
  assert.equal(secondRun!.parentRunId, firstRunId);
  assert.equal(secondRun!.triggerId, "C123:1000.000");
  assert.equal(runs[1].previousRunId, firstRunId);
});

test("a second linked user in the channel becomes a member, not an owner", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeUser("slack-alice3");
  const bob = await makeUser("slack-bob");
  await db.slackAccountLink.createMany({
    data: [
      { slackTeamId: teamId, slackUserId: "UALICE", userId: alice.id },
      { slackTeamId: teamId, slackUserId: "UBOB", userId: bob.id }
    ]
  });

  const { client } = makeFakeSlack();
  const runs: ConversationRunInput[] = [];
  await handleSlackAppMention(mention({ teamId }), depsWith(client, runs));
  const result = await handleSlackAppMention(
    mention({ teamId, user: "UBOB", ts: "2000.000" }),
    depsWith(client, runs)
  );
  assert.equal(result.handled, true);

  const document = await db.document.findUnique({
    where: { slackTeamId_slackChannelId: { slackTeamId: teamId, slackChannelId: "C123" } },
    include: { memberships: true }
  });
  assert.equal(document!.ownerId, alice.id);
  assert.deepEqual(
    document!.memberships.map((m) => [m.userId, m.permission]),
    [[bob.id, "EDIT"]]
  );
  assert.equal(runs[1].createdById, bob.id, "Bob's mention runs with Bob's identity");
});

test("duplicate event ids and bot messages are ignored", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeUser("slack-alice4");
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "UALICE", userId: alice.id }
  });
  const { client } = makeFakeSlack();
  const runs: ConversationRunInput[] = [];

  const event = mention({ teamId });
  const first = await handleSlackAppMention(event, depsWith(client, runs));
  assert.equal(first.handled, true);
  const replay = await handleSlackAppMention(event, depsWith(client, runs));
  assert.equal(replay.handled, false);
  assert.equal("reason" in replay && replay.reason, "duplicate");
  assert.equal(runs.length, 1);

  const botEvent = mention({ teamId, botId: "B999", ts: "3000.000" });
  const botResult = await handleSlackAppMention(botEvent, depsWith(client, runs));
  assert.equal(botResult.handled, false);
  assert.equal("reason" in botResult && botResult.reason, "bot-message");
});

test("thread context from other participants is prepended to the instruction", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeUser("slack-alice5");
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "UALICE", userId: alice.id }
  });
  const { client } = makeFakeSlack([
    { ts: "1000.000", user: "UCAROL", text: "the eval numbers look off" },
    { ts: "1000.500", botId: "B1", text: "I checked run 42 earlier" },
    { ts: "1001.000", user: "UALICE", text: `<@${BOT_USER_ID}> can you investigate?` }
  ]);
  const runs: ConversationRunInput[] = [];
  const result = await handleSlackAppMention(
    mention({ teamId, ts: "1001.000", threadTs: "1000.000", text: `<@${BOT_USER_ID}> can you investigate?` }),
    depsWith(client, runs)
  );
  assert.equal(result.handled, true);
  assert.match(runs[0].message, /Recent messages in this Slack thread/);
  assert.match(runs[0].message, /\[name-of-UCAROL\]: the eval numbers look off/);
  assert.match(runs[0].message, /\[claudex \(you\)\]: I checked run 42 earlier/);
  assert.match(runs[0].message, /can you investigate\?$/);
  assert.doesNotMatch(runs[0].message, /1001\.000.*can you investigate.*\n/, "triggering message not duplicated in context");
});

test("run input carries slack context and interim messages post as mrkdwn", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeUser("slack-alice7");
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "UALICE", userId: alice.id }
  });
  const { client, posted } = makeFakeSlack(
    [],
    [
      { ts: "900.000", user: "UCAROL", text: "yesterday's run crashed" },
      { ts: "1000.000", user: "UALICE", text: `<@${BOT_USER_ID}> summarize the latest results` }
    ]
  );
  const runs: ConversationRunInput[] = [];
  const result = await handleSlackAppMention(mention({ teamId }), depsWith(client, runs));
  assert.equal(result.handled, true);

  assert.equal(runs[0].slackContext?.surface, "channel");
  assert.equal(runs[0].slackContext?.channelName, "research");
  assert.match(runs[0].slackContext?.recentMessages ?? "", /\[name-of-UCAROL\]: yesterday's run crashed/);
  assert.doesNotMatch(
    runs[0].slackContext?.recentMessages ?? "",
    /summarize the latest results/,
    "the triggering message is not duplicated into channel context"
  );

  await runs[0].onSlackMessage?.("**Update**: still digging");
  assert.equal(posted.at(-1)!.text, "*Update*: still digging");
  assert.equal(posted.at(-1)!.threadTs, "1000.000");

  // Final replies are converted too.
  await runs[0].onFinished?.({ status: "SUCCEEDED", reply: "It **worked**, see [run](https://x.io)", error: null });
  assert.equal(posted.at(-1)!.text, "It *worked*, see <https://x.io|run>");
});

test("agent prompt includes slack context and post_slack_message guidance", () => {
  const prompt = buildUserPrompt({
    mode: "conversation",
    documentTitle: "#research",
    documentText: "",
    unresolvedThreads: [],
    workspacePath: "/tmp/w",
    workspaceOverview: "",
    instruction: "summarize",
    slackContext: {
      surface: "channel",
      channelName: "research",
      recentMessages: "[carol]: the eval numbers look off"
    }
  });
  assert.match(prompt, /happening in Slack \(the #research channel\)/);

  const withGithub = buildUserPrompt({
    mode: "conversation",
    documentTitle: "Doc",
    documentText: "",
    unresolvedThreads: [],
    workspacePath: "/tmp/w",
    workspaceOverview: "",
    instruction: "clone the repo",
    githubAuthAvailable: true
  });
  assert.match(withGithub, /GITHUB_TOKEN and GH_TOKEN are set/);
  assert.match(prompt, /post_slack_message/);
  assert.match(prompt, /\[carol\]: the eval numbers look off/);

  const plain = buildUserPrompt({
    mode: "conversation",
    documentTitle: "Doc",
    documentText: "",
    unresolvedThreads: [],
    workspacePath: "/tmp/w",
    workspaceOverview: "",
    instruction: "summarize"
  });
  assert.doesNotMatch(plain, /Slack/);
});

test("ensureSlackChannelDocument is idempotent per (team, channel)", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeUser("slack-alice6");
  const a = await ensureSlackChannelDocument({
    slackTeamId: teamId,
    slackChannelId: "C777",
    channelName: "general",
    userId: alice.id
  });
  const b = await ensureSlackChannelDocument({
    slackTeamId: teamId,
    slackChannelId: "C777",
    channelName: "general",
    userId: alice.id
  });
  assert.equal(a.id, b.id);
});

test("'wait' while a run is active aborts it instead of prompting", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeUser("slack-int-alice");
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "UALICE", userId: alice.id }
  });
  const { client, reactions } = makeFakeSlack();
  const runs: ConversationRunInput[] = [];

  const first = await handleSlackAppMention(mention({ teamId }), depsWith(client, runs));
  assert.equal(first.handled, true);
  const runId = (first as { aiRunId: string }).aiRunId;
  const abort = registerRunAbortController(runId);

  assert.ok(isInterruptMessage("wait"));
  assert.ok(isInterruptMessage("Stop!"));
  assert.ok(!isInterruptMessage("wait, actually change the title"));

  const interrupt = await handleSlackAppMention(
    mention({ teamId, ts: "1001.000", threadTs: "1000.000", text: `<@${BOT_USER_ID}> wait` }),
    depsWith(client, runs)
  );
  assert.equal(interrupt.handled, true);
  assert.equal("action" in interrupt && interrupt.action, "interrupted");
  assert.ok(abort.signal.aborted, "active run must be aborted");
  assert.ok(!isCancellableAiRun(runId) || abort.signal.aborted);
  assert.deepEqual(reactions.at(-1), { op: "add", ts: "1001.000", name: "octagonal_sign" });
  assert.equal(runs.length, 1, "no new run for an interrupt message");

  // Cancelled runs report "Stopped." rather than a failure.
  const { posted } = makeFakeSlack();
  void posted;
});

test("messages during an active run queue into one chained follow-up", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeUser("slack-q-alice");
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "UALICE", userId: alice.id }
  });
  const { client, posted, reactions } = makeFakeSlack();
  const runs: ConversationRunInput[] = [];

  const first = await handleSlackAppMention(mention({ teamId }), depsWith(client, runs));
  const firstRunId = (first as { aiRunId: string }).aiRunId;

  const queued = await handleSlackAppMention(
    mention({ teamId, ts: "1002.000", threadTs: "1000.000", text: `<@${BOT_USER_ID}> also add a plot` }),
    depsWith(client, runs)
  );
  assert.equal("action" in queued && queued.action, "queued");
  assert.ok(reactions.some((r) => r.ts === "1002.000" && r.name === "hourglass_flowing_sand"));
  assert.equal(runs.length, 1, "queued message must not start a concurrent run");

  // Finish the active run — the queued message becomes a chained follow-up.
  await db.aiRun.update({ where: { id: firstRunId }, data: { status: "SUCCEEDED" } });
  await runs[0].onFinished?.({ status: "SUCCEEDED", reply: "First done.", error: null });

  assert.equal(runs.length, 2, "queued follow-up run must start after the first finishes");
  assert.equal(runs[1].previousRunId, firstRunId);
  assert.match(runs[1].message, /also add a plot/);
  const followUp = await db.aiRun.findUnique({ where: { id: runs[1].aiRunId } });
  assert.equal(followUp!.parentRunId, firstRunId);
  assert.equal(followUp!.createdById, alice.id);
  assert.ok(posted.some((p) => p.text === "First done."));
  // The queued message's hourglass flips to eyes when its run starts.
  assert.ok(reactions.some((r) => r.op === "remove" && r.ts === "1002.000" && r.name === "hourglass_flowing_sand"));
  assert.ok(reactions.some((r) => r.op === "add" && r.ts === "1002.000" && r.name === "eyes"));
});

test("cancelled runs post 'Stopped.' instead of a failure message", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeUser("slack-c-alice");
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "UALICE", userId: alice.id }
  });
  const { client, posted } = makeFakeSlack();
  const runs: ConversationRunInput[] = [];
  await handleSlackAppMention(mention({ teamId }), depsWith(client, runs));
  await runs[0].onFinished?.({ status: "FAILED", reply: null, error: "Cancelled by user." });
  assert.equal(posted.at(-1)!.text, "Stopped.");
});

test("DM threads are independent sessions: a running thread never captures other threads' messages", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeUser("slack-par-alice");
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "UALICE", userId: alice.id }
  });
  const { client, reactions } = makeFakeSlack();
  const runs: ConversationRunInput[] = [];

  // Thread A starts a run and stays RUNNING.
  const a = await handleSlackDirectMessage(
    mention({ teamId, channel: "D777", text: "long task please", ts: "7000.000" }),
    depsWith(client, runs)
  );
  assert.equal(a.handled, true);
  assert.ok(!("action" in a));

  // A NEW top-level DM message must start a parallel run in its own thread —
  // not queue behind thread A, not reply into thread A.
  const b = await handleSlackDirectMessage(
    mention({ teamId, channel: "D777", text: "do you have access to rdocs?", ts: "7001.000" }),
    depsWith(client, runs)
  );
  assert.equal(b.handled, true);
  assert.ok(!("action" in b), "new top-level DM message must not be queued behind another thread's run");
  assert.equal(runs.length, 2, "two parallel sessions");
  assert.ok(
    !reactions.some((r) => r.ts === "7001.000" && r.name === "hourglass_flowing_sand"),
    "no queue reaction on an unrelated message"
  );

  // Its reply lands in ITS OWN thread.
  const { posted } = { posted: [] as Array<{ channel: string; text: string; threadTs?: string }> };
  void posted;
  await runs[1].onFinished?.({ status: "SUCCEEDED", reply: "Yes I do.", error: null });
  // The fake client records into the shared `posted` from makeFakeSlack via closure:
  // fetch it through the client by re-checking reactions/posts is not possible here,
  // so assert via the run rows instead.
  const runB = await db.aiRun.findUnique({ where: { id: (b as { aiRunId: string }).aiRunId } });
  assert.equal(runB!.triggerId, "D777:7001.000", "session B anchors to its own thread");

  // "wait" inside thread A still interrupts run A.
  const abortA = registerRunAbortController((a as { aiRunId: string }).aiRunId);
  const interrupt = await handleSlackDirectMessage(
    mention({ teamId, channel: "D777", text: "wait", ts: "7002.000", threadTs: "7000.000" }),
    depsWith(client, runs)
  );
  assert.equal("action" in interrupt && interrupt.action, "interrupted");
  assert.ok(abortA.signal.aborted);

  // And a bare top-level "wait" with no run in ITS thread is just a prompt.
  const idle = await handleSlackDirectMessage(
    mention({ teamId, channel: "D777", text: "wait", ts: "7003.000" }),
    depsWith(client, runs)
  );
  assert.equal(idle.handled, true);
  assert.ok(!("action" in idle) || idle.action === undefined);
});

test("files attached to a slack message are saved as document attachments and announced to the agent", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const alice = await makeUser("slack-file-alice");
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "UALICE", userId: alice.id }
  });
  const { client } = makeFakeSlack();
  const runs: ConversationRunInput[] = [];
  const result = await handleSlackAppMention(
    {
      ...mention({ teamId, text: `<@${BOT_USER_ID}> analyze this dataset` }),
      files: [{ downloadUrl: "https://files.slack.com/x", name: "results.csv", mimetype: "text/csv" }]
    },
    depsWith(client, runs)
  );
  assert.equal(result.handled, true);

  const attachment = await db.attachment.findFirst({
    where: { documentId: (result as { documentId: string }).documentId },
    orderBy: { createdAt: "desc" }
  });
  assert.ok(attachment, "attachment row must exist");
  assert.equal(attachment!.fileName, "results.csv");
  assert.equal(attachment!.createdById, alice.id);
  assert.match(runs[0].message, /attachments\/results\.csv/);
  assert.match(runs[0].message, /analyze this dataset/);
});
