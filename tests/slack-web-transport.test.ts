import assert from "node:assert/strict";
import test from "node:test";

import { createSlackWebClient } from "../lib/slack/web";

// Slack's Web API only honors application/json bodies on a subset of methods
// (chat.postMessage etc.). GET-style methods — conversations.history/replies/
// members, users.conversations, users.info — silently IGNORE a JSON body and
// fall back to defaults, which made every membership check fail and hid
// private channels (real incident: list_slack_channels returned "none").
// The client must therefore send form-encoded params on every call.
test("slack web client sends form-encoded params that Slack honors on GET-style methods", async (t) => {
  const requests: Array<{ url: string; contentType: string; params: URLSearchParams }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const contentType = String((init?.headers as Record<string, string>)?.["Content-Type"] ?? "");
    const body = String(init?.body ?? "");
    assert.doesNotMatch(contentType, /application\/json/, `JSON body sent to ${url} — Slack ignores it`);
    const params = new URLSearchParams(body);
    requests.push({ url: String(url), contentType, params });
    return new Response(JSON.stringify({ ok: true, messages: [], members: [], channels: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = createSlackWebClient("xoxb-test");

  await client.channelHistory({ channel: "C123", limit: 30 });
  assert.equal(requests.at(-1)!.params.get("channel"), "C123");
  assert.equal(requests.at(-1)!.params.get("limit"), "30");

  await client.channelMembers("C123");
  assert.equal(requests.at(-1)!.params.get("channel"), "C123");

  await client.botChannels();
  assert.equal(requests.at(-1)!.params.get("types"), "public_channel,private_channel,im");

  await client.threadReplies({ channel: "C123", ts: "1.0" });
  assert.equal(requests.at(-1)!.params.get("ts"), "1.0");

  await client.userInfo("U1");
  assert.equal(requests.at(-1)!.params.get("user"), "U1");

  await client.postMessage({ channel: "C123", text: "hi", threadTs: "1.0" });
  assert.equal(requests.at(-1)!.params.get("thread_ts"), "1.0");
  assert.equal(requests.at(-1)!.params.get("text"), "hi");
});
