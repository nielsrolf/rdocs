import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import {
  handleSlackAppMention,
  handleSlackSettingsSlashCommand,
  handleSlackThreadReply,
  type SlackMentionEvent
} from "../lib/slack/events";
import { parseSettingsCommand, resolveSettingsUpdate, type AgentSettingsValue } from "../lib/slack/thread-settings";
import type { ConversationRunInput } from "../lib/agent-conversation";
import type { SlackClient } from "../lib/slack/web";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const BOT = "UBOT";
const CODEX_DEFAULT = "codex/openai/gpt-5.6-terra";

function fakeSlack() {
  const posted: Array<{ channel: string; text: string; threadTs?: string }> = [];
  const reactions: Array<{ ts: string; name: string }> = [];
  const client: SlackClient = {
    async postMessage(args) {
      posted.push(args);
      return { ts: `9${posted.length}.000`, channel: args.channel };
    },
    async postEphemeral() {},
    async addReaction({ ts, name }) {
      reactions.push({ ts, name });
    },
    async removeReaction() {},
    async channelInfo() {
      return { name: "research" };
    },
    async userInfo(userId) {
      return { displayName: userId };
    },
    async threadReplies() {
      return [];
    },
    async channelHistory() {
      return [];
    },
    async botChannels() {
      return [];
    },
    async channelMembers() {
      return [];
    },
    async downloadFile() {
      return null;
    },
    async uploadFile() {}
  };
  return { client, posted, reactions };
}

async function linkedTeam() {
  const teamId = `T-${crypto.randomUUID()}`;
  const user = await db.user.create({
    data: { email: `settings-${crypto.randomUUID()}@example.com`, name: "alice", passwordHash: "x" }
  });
  await db.slackAccountLink.create({ data: { slackTeamId: teamId, slackUserId: "UALICE", userId: user.id } });
  return { teamId, user };
}

function message(teamId: string, text: string, ts: string, threadTs?: string): SlackMentionEvent {
  return { eventId: `ev-${crypto.randomUUID()}`, teamId, channel: "C1", user: "UALICE", text, ts, threadTs };
}

// The fake runner never finishes runs in the DB; do it so follow-ups start new runs.
async function finish(run: ConversationRunInput) {
  await db.aiRun.update({ where: { id: run.aiRunId }, data: { status: "SUCCEEDED" } });
  await run.onFinished?.({ status: "SUCCEEDED", reply: "ok", error: null });
}

function deps(client: SlackClient, runs: ConversationRunInput[]) {
  return {
    slack: client,
    appUrl: "http://localhost:14141",
    botUserId: BOT,
    startRun: async (input: ConversationRunInput) => {
      runs.push(input);
    }
  };
}

test("parseSettingsCommand reads multi-word values and aliases", () => {
  assert.equal(parseSettingsCommand("summarize this"), null);
  assert.equal(parseSettingsCommand("/settingsfoo"), null);
  assert.deepEqual(parseSettingsCommand("/settings"), { kind: "show" });
  assert.deepEqual(parseSettingsCommand("  /settings reset "), { kind: "reset" });
  assert.deepEqual(parseSettingsCommand("/settings scaffold=claude code model=opus-5-5 thinking=max"), {
    kind: "set",
    scaffold: "claude-code",
    model: "opus-5-5",
    thinking: "max"
  });
  assert.deepEqual(parseSettingsCommand("/settings harness=Codex effort=extra high"), {
    kind: "set",
    scaffold: "codex",
    thinking: "xhigh"
  });
  assert.equal(parseSettingsCommand("/settings thinking=huge")?.kind, "invalid");
  assert.equal(parseSettingsCommand("/settings please model=opus")?.kind, "invalid");
  assert.equal(parseSettingsCommand("/settings model=")?.kind, "invalid");
});

test("resolveSettingsUpdate maps short model names per scaffold", () => {
  const current: AgentSettingsValue = { model: null, effort: null };
  const set = (text: string, from = current) => {
    const command = parseSettingsCommand(text);
    assert.equal(command?.kind, "set");
    return resolveSettingsUpdate({
      command: command as Extract<typeof command, { kind: "set" }> & { kind: "set" },
      current: from,
      codexDefaultModel: CODEX_DEFAULT
    });
  };
  assert.deepEqual(set("/settings model=opus-5-5 thinking=max"), {
    update: { agentModel: "claude-opus-5-5", agentEffort: "max" }
  });
  assert.deepEqual(set("/settings model=opus"), { update: { agentModel: "claude-opus-latest" } });
  assert.deepEqual(set("/settings scaffold=codex"), { update: { agentModel: CODEX_DEFAULT } });
  assert.deepEqual(set("/settings scaffold=codex model=gpt-5.6-luna"), {
    update: { agentModel: "codex/openai/gpt-5.6-luna" }
  });
  // Back from Codex to Claude Code without a model picks the default Claude model.
  assert.deepEqual(set("/settings scaffold=claude code", { model: CODEX_DEFAULT, effort: null }), {
    update: { agentModel: "claude-sonnet-latest" }
  });
  // Same scaffold, no model: the model is left alone.
  assert.deepEqual(set("/settings scaffold=claude code thinking=low"), { update: { agentEffort: "low" } });
  assert.ok("error" in set("/settings scaffold=codex model=opus"));
  assert.ok("error" in set("/settings model=???"));
});

test("@claudex /settings in a thread configures it, and later runs there use it", async () => {
  const { teamId } = await linkedTeam();
  const { client, posted, reactions } = fakeSlack();
  const runs: ConversationRunInput[] = [];

  // A first run opens the thread with the defaults.
  await handleSlackAppMention(message(teamId, `<@${BOT}> hello`, "100.000"), deps(client, runs));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].agentConfig?.model ?? null, null);
  await finish(runs[0]);

  const result = await handleSlackAppMention(
    message(teamId, `<@${BOT}> /settings scaffold=claude code model=opus-5-5 thinking=max`, "101.000", "100.000"),
    deps(client, runs)
  );
  assert.equal((result as { action?: string }).action, "settings");
  assert.equal(runs.length, 1, "a settings command must not start a run");
  assert.deepEqual(reactions.at(-1), { ts: "101.000", name: "gear" });
  const confirmation = posted.at(-1)!;
  assert.equal(confirmation.threadTs, "100.000");
  assert.match(confirmation.text, /Claude Code.*Opus 5\.5.*Max/);

  // A plain reply in the thread now runs with the thread's settings…
  await handleSlackThreadReply(message(teamId, "go on", "102.000", "100.000"), deps(client, runs));
  assert.equal(runs.length, 2);
  assert.deepEqual(
    { model: runs[1].agentConfig?.model, effort: runs[1].agentConfig?.effort },
    { model: "claude-opus-5-5", effort: "max" }
  );
  await finish(runs[1]);

  // …while another thread in the same channel keeps the channel defaults.
  await handleSlackAppMention(message(teamId, `<@${BOT}> other topic`, "200.000"), deps(client, runs));
  assert.equal(runs[2].agentConfig?.model ?? null, null);
  assert.equal(runs[2].agentConfig?.effort ?? null, null);

  // Reset puts the thread back on the defaults.
  await handleSlackAppMention(message(teamId, `<@${BOT}> /settings reset`, "103.000", "100.000"), deps(client, runs));
  await handleSlackThreadReply(message(teamId, "again", "104.000", "100.000"), deps(client, runs));
  assert.equal(runs.at(-1)!.agentConfig?.model ?? null, null);
});

test("an invalid /settings answers with usage and changes nothing", async () => {
  const { teamId } = await linkedTeam();
  const { client, posted, reactions } = fakeSlack();
  const runs: ConversationRunInput[] = [];
  await handleSlackAppMention(message(teamId, `<@${BOT}> /settings thinking=huge`, "300.000"), deps(client, runs));
  assert.equal(runs.length, 0);
  assert.deepEqual(reactions.at(-1), { ts: "300.000", name: "x" });
  assert.match(posted.at(-1)!.text, /Unknown thinking level/);
  assert.match(posted.at(-1)!.text, /Usage/);
});

test("top-level /settings slash command opens a thread with the settings applied", async () => {
  const { teamId } = await linkedTeam();
  const { client, posted } = fakeSlack();
  const runs: ConversationRunInput[] = [];

  const reply = await handleSlackSettingsSlashCommand(
    { teamId, channel: "C1", user: "UALICE", text: "model=fable thinking=extra" },
    deps(client, runs)
  );
  assert.match(reply, /Thread opened/);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].threadTs, undefined, "the root message is top-level");
  const rootTs = "91.000";

  // A plain (unmentioned) reply under the bot's root message is picked up.
  const result = await handleSlackThreadReply(message(teamId, "start please", "92.000", rootTs), deps(client, runs));
  assert.equal(result.handled, true);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].agentConfig?.model, "claude-fable-latest");
  assert.equal(runs[0].agentConfig?.effort, "xhigh");

  // Without arguments it only explains, posting nothing.
  const help = await handleSlackSettingsSlashCommand(
    { teamId, channel: "C1", user: "UALICE", text: "" },
    deps(client, runs)
  );
  assert.match(help, /Channel defaults/);
  assert.equal(posted.length, 1);
});
