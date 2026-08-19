import assert from "node:assert/strict";
import test from "node:test";

import { createAgentInputChannel } from "../agent-core/input-channel";
import { buildUserMessageStream, type ClaudeResearchAgentInput } from "../agent-core/agent";

function baseInput(): ClaudeResearchAgentInput {
  return {
    mode: "conversation",
    instruction: "do the thing",
    documentTitle: "Doc",
    documentBlocks: [],
    workspacePath: "/tmp/does-not-matter"
  } as unknown as ClaudeResearchAgentInput;
}

test("input channel yields pushed messages and ends when closed", async () => {
  const channel = createAgentInputChannel();
  assert.equal(channel.push("one"), true);
  assert.equal(channel.pendingCount(), 1);

  const seen: string[] = [];
  const consumer = (async () => {
    for await (const text of channel) seen.push(text);
  })();

  // A message pushed while the consumer is parked must still be delivered.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(channel.push("two"), true);
  await new Promise((r) => setTimeout(r, 5));

  channel.close();
  await consumer;
  assert.deepEqual(seen, ["one", "two"]);

  // After close the caller must fall back to queueing — never a silent drop.
  assert.equal(channel.isClosed(), true);
  assert.equal(channel.push("three"), false);
});

test("buildUserMessageStream keeps the turn open for injected user messages", async () => {
  const channel = createAgentInputChannel();
  const stream = buildUserMessageStream(baseInput(), channel);

  const messages: string[] = [];
  const consumer = (async () => {
    for await (const message of stream) {
      const content = message.message.content;
      const text = typeof content === "string" ? content : content.map((b: any) => b.text ?? "").join("");
      messages.push(text);
      if (messages.length === 1) {
        // Simulate a Slack message arriving mid-run.
        channel.push("also add a plot");
      }
      if (messages.length === 2) {
        channel.close();
      }
    }
  })();

  await consumer;
  assert.equal(messages.length, 2, "the injected message becomes a second user turn");
  assert.match(messages[0], /do the thing/);
  assert.equal(messages[1], "also add a plot");
});

test("buildUserMessageStream without a channel yields exactly one message", async () => {
  const messages = [];
  for await (const message of buildUserMessageStream(baseInput())) messages.push(message);
  assert.equal(messages.length, 1);
});
