import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { GET as getChannelRun } from "../app/api/agent-channels/[triggerId]/runs/[runId]/route";
import { upsertAgentApiChannel } from "../lib/agent-api-channels";
import { summarizeRunUsage } from "../lib/ai-runs";
import { db } from "../lib/db";
import { estimateListPriceUsd } from "../lib/model-pricing";

const usage = (fields: Record<string, unknown>) =>
  `[usage] ${JSON.stringify({ requestId: crypto.randomUUID(), cachedInputTokens: 0, cacheWriteTokens: 0, costUsd: null, complete: true, ...fields })}`;

test("list prices: per model family, with cache reads and writes; unknown models get no estimate", () => {
  const million = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
  // $2 in + $10 out + $0.10 cache read + $2.50 cache write (1.25 x input)
  assert.equal(estimateListPriceUsd("claude-sonnet-5-5", million), 14.6);
  // $8 + $40 + $0.20 + $10
  assert.equal(estimateListPriceUsd("claude-fable-5-2", million), 58.2);
  // dated and proxy-style names resolve to the same model; the longest prefix wins
  const tokens = { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
  assert.equal(estimateListPriceUsd("claude-haiku-4-5-20251001", tokens), 1);
  assert.equal(estimateListPriceUsd("anthropic/claude-opus-5-5", tokens), 4);
  assert.equal(estimateListPriceUsd("claude-opus-5", tokens), 5);
  assert.equal(estimateListPriceUsd("claude-fable-5-1", tokens), 10);
  for (const unknown of ["gpt-5.5", "claude-opus-50", "qwen3.6-27b", null, ""]) {
    assert.equal(estimateListPriceUsd(unknown, tokens), null, String(unknown));
  }
});

test("run usage: reported cost and a hypothetical list-price estimate are kept apart", async () => {
  const user = await db.user.create({ data: { email: `usage-${crypto.randomUUID()}@example.com`, name: "u", passwordHash: "x" } });
  const document = await db.document.create({ data: { ownerId: user.id, title: "Usage", content: "{}" } });
  const channel = await upsertAgentApiChannel({ documentId: document.id, createdById: user.id, label: "test" });
  const run = await db.aiRun.create({
    data: { documentId: document.id, triggerType: "API", triggerId: channel.channel.id, instruction: "t", status: "SUCCEEDED" }
  });
  const events = [
    // the agent's own session on a Claude subscription: tokens, no cost
    usage({ provider: "anthropic", billing: "subscription", model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 2000, cachedInputTokens: 500_000, cacheWriteTokens: 60_000 }),
    usage({ provider: "anthropic", billing: "subscription", model: "claude-sonnet-5-5", inputTokens: 500, outputTokens: 1000, cachedInputTokens: 560_000 }),
    // code the agent ran, through LiteLLM: the proxy reports the cost
    usage({ provider: "litellm", model: "claude-sonnet-5-5", inputTokens: 10_000, outputTokens: 500, costUsd: 0.03 }),
    usage({ provider: "litellm", model: "gpt-5.5-mini", inputTokens: 4000, outputTokens: 100, costUsd: 0.01 }),
    // a model with no known price contributes tokens only
    usage({ provider: "openai", model: "gpt-5.5", inputTokens: 7000, outputTokens: 300 })
  ];
  for (const message of events) await db.aiRunEvent.create({ data: { aiRunId: run.id, role: "system", message } });

  const summary = (await summarizeRunUsage([run.id])).get(run.id)!;
  assert.equal(summary.calls, 5);
  assert.equal(Number(summary.costUsd?.toFixed(4)), 0.04, "what the providers reported");
  // (1500 in x $2 + 3000 out x $10 + 1.06M cache read x $0.10 + 60k cache write x $2.50) / 1M
  assert.equal(Number(summary.estimatedCostUsd?.toFixed(4)), 0.289);
  assert.equal(summary.estimatedBilling, "subscription");
  assert.equal(summary.inputTokens, 22_500);
  // one entry per model; the LiteLLM call of the same model is not estimated a second time
  const sonnet = summary.models.find((model) => model.model === "claude-sonnet-5-5")!;
  assert.deepEqual(
    { calls: sonnet.calls, cost: sonnet.costUsd, estimate: Number(sonnet.estimatedCostUsd?.toFixed(4)) },
    { calls: 3, cost: 0.03, estimate: 0.289 }
  );
  assert.equal(summary.models.find((model) => model.model === "gpt-5.5")?.estimatedCostUsd, null);

  // an API key next to a subscription, and events from before the broker recorded which
  const mixed = await db.aiRun.create({ data: { documentId: document.id, triggerType: "API", triggerId: channel.channel.id, instruction: "t", status: "SUCCEEDED" } });
  await db.aiRunEvent.create({ data: { aiRunId: mixed.id, role: "system", message: usage({ provider: "anthropic", billing: "api-key", model: "claude-opus-5-5", inputTokens: 1_000_000, outputTokens: 0 }) } });
  const keyed = (await summarizeRunUsage([mixed.id])).get(mixed.id)!;
  assert.deepEqual([keyed.costUsd, keyed.estimatedCostUsd, keyed.estimatedBilling], [null, 4, "api-key"]);
  await db.aiRunEvent.create({ data: { aiRunId: mixed.id, role: "system", message: usage({ provider: "anthropic", model: "claude-opus-5-5", inputTokens: 1_000_000, outputTokens: 0 }) } });
  const old = await db.aiRun.create({ data: { documentId: document.id, triggerType: "API", triggerId: channel.channel.id, instruction: "t", status: "SUCCEEDED" } });
  await db.aiRunEvent.create({ data: { aiRunId: old.id, role: "system", message: usage({ provider: "anthropic", model: "claude-opus-5-5", inputTokens: 500_000, outputTokens: 0 }) } });
  const later = await summarizeRunUsage([old.id]);
  assert.deepEqual([later.get(old.id)?.estimatedCostUsd, later.get(old.id)?.estimatedBilling], [2, "unknown"]);

  // the integration that started the run reads the same summary with its channel token
  const response = await getChannelRun(
    new Request(`http://localhost/api/agent-channels/${channel.channel.id}/runs/${run.id}`, { headers: { authorization: `Bearer ${channel.token}` } }),
    { params: Promise.resolve({ triggerId: channel.channel.id, runId: run.id }) }
  );
  const body = (await response.json()) as { usage: { costUsd: number; estimatedCostUsd: number; estimatedBilling: string } };
  assert.equal(response.status, 200);
  assert.equal(Number(body.usage.estimatedCostUsd.toFixed(4)), 0.289);
  assert.equal(body.usage.estimatedBilling, "subscription");
  assert.equal(Number(body.usage.costUsd.toFixed(4)), 0.04);
});
