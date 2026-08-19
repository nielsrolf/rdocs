import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { encryptSecret } from "../lib/secret-crypto";
import { resolveTranscriptionConfig } from "../lib/slack/transcribe";
import { handleSlackDirectMessage, type SlackMentionEvent } from "../lib/slack/events";
import type { ConversationRunInput } from "../lib/agent-conversation";
import type { SlackClient } from "../lib/slack/web";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

function makeSlack() {
  const posted: Array<{ channel: string; text: string; threadTs?: string }> = [];
  const client: SlackClient = {
    async postMessage(args) {
      posted.push(args);
      return { ts: "1.0" };
    },
    async postEphemeral() {},
    async addReaction() {},
    async removeReaction() {},
    async channelInfo() {
      return { name: null };
    },
    async userInfo() {
      return { displayName: "niels" };
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
      return Buffer.from("audio-bytes");
    },
    async uploadFile() {}
  };
  return { client, posted };
}

function voiceEvent(teamId: string, overrides: Partial<SlackMentionEvent> = {}): SlackMentionEvent {
  return {
    eventId: `ev-${crypto.randomUUID()}`,
    teamId,
    channel: "D900",
    user: "UALICE",
    subtype: "file_share",
    text: "",
    ts: "9000.000",
    files: [{ downloadUrl: "https://files.slack.com/audio", name: "voice.m4a", mimetype: "audio/mp4" }],
    ...overrides
  };
}

async function makeLinkedUser(teamId: string) {
  const user = await db.user.create({
    data: { email: `voice-${crypto.randomUUID()}@example.com`, name: "voice-user", passwordHash: "x" }
  });
  await db.slackAccountLink.create({
    data: { slackTeamId: teamId, slackUserId: "UALICE", userId: user.id }
  });
  return user;
}

test("transcription config resolution: doc env → user openai cred → litellm; none → null", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  const user = await makeLinkedUser(teamId);
  const doc = await db.document.create({ data: { ownerId: user.id, title: "v", content: "{}" } });

  assert.equal(await resolveTranscriptionConfig(doc.id, user.id), null);

  await db.userCredential.create({
    data: { userId: user.id, provider: "openai", kind: "api_key", secret: encryptSecret("sk-proj-test123") }
  });
  const viaCred = await resolveTranscriptionConfig(doc.id, user.id);
  assert.equal(viaCred?.provider, "openai");
  assert.equal(viaCred?.apiKey, "sk-proj-test123");
  assert.match(viaCred!.url, /api\.openai\.com\/v1\/audio\/transcriptions/);

  // litellm fallback for a different user without an openai key
  const other = await db.user.create({
    data: { email: `voice2-${crypto.randomUUID()}@example.com`, name: "v2", passwordHash: "x" }
  });
  const doc2 = await db.document.create({ data: { ownerId: other.id, title: "v2", content: "{}" } });
  await db.userCredential.create({
    data: { userId: other.id, provider: "litellm", kind: "api_key", secret: encryptSecret("llm-key") }
  });
  const prevBase = process.env.LITELLM_BASE_URL;
  process.env.LITELLM_BASE_URL = "http://host.docker.internal:9274";
  const viaLitellm = await resolveTranscriptionConfig(doc2.id, other.id);
  process.env.LITELLM_BASE_URL = prevBase;
  assert.equal(viaLitellm?.provider, "litellm");
  assert.equal(viaLitellm?.url, "http://localhost:9274/v1/audio/transcriptions", "container host swaps to localhost server-side");
});

test("voice-only message with transcription becomes the user's message", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  await makeLinkedUser(teamId);
  const { client } = makeSlack();
  const runs: ConversationRunInput[] = [];

  const result = await handleSlackDirectMessage(voiceEvent(teamId), {
    slack: client,
    appUrl: "http://localhost:14141",
    botUserId: "UBOT",
    startRun: async (input) => {
      runs.push(input);
    },
    transcribe: async () => ({ text: "please summarize the eval results" })
  });
  assert.equal(result.handled, true, JSON.stringify(result));
  assert.equal(runs.length, 1);
  assert.match(runs[0].message, /please summarize the eval results/);
  assert.doesNotMatch(runs[0].message, /\(no message\)/);
});

test("voice message without any transcription credential posts the activation hint, no run", async () => {
  const teamId = `T-${crypto.randomUUID()}`;
  await makeLinkedUser(teamId);
  const { client, posted } = makeSlack();
  const runs: ConversationRunInput[] = [];

  const result = await handleSlackDirectMessage(voiceEvent(teamId, { ts: "9001.000" }), {
    slack: client,
    appUrl: "http://localhost:14141",
    botUserId: "UBOT",
    startRun: async (input) => {
      runs.push(input);
    },
    transcribe: async () => ({ unavailable: true })
  });
  assert.equal(result.handled, false);
  assert.equal("reason" in result && result.reason, "voice-unavailable");
  assert.equal(runs.length, 0);
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /OpenAI API key|LiteLLM/);

  // With typed text alongside, the run proceeds and carries the hint for the agent.
  const withText = await handleSlackDirectMessage(
    voiceEvent(teamId, { ts: "9002.000", text: "also check the dashboard" }),
    {
      slack: client,
      appUrl: "http://localhost:14141",
      botUserId: "UBOT",
      startRun: async (input) => {
        runs.push(input);
      },
      transcribe: async () => ({ unavailable: true })
    }
  );
  assert.equal(withText.handled, true);
  assert.match(runs[0].message, /also check the dashboard/);
  assert.match(runs[0].message, /voice message.*no transcription credential/i);
});
