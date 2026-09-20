import test from "node:test";
import assert from "node:assert/strict";
import { createUsageCapture } from "../lib/credential-broker/usage";

test("merges chunked Anthropic usage without retaining content", () => {
  const capture = createUsageCapture({ requestId: "r", provider: "anthropic", costUsd: null });
  capture.push('data: {"message":{"model":"m","usage":{"input_tokens":12,"cache_read_input_tokens":4}}}\n\n');
  capture.push('data: {"usage":{"output_');
  capture.push('tokens":8}}\n\n');
  assert.deepEqual(capture.finish(true), { requestId: "r", provider: "anthropic", model: "m",
    inputTokens: 12, outputTokens: 8, cachedInputTokens: 4, cacheWriteTokens: 0, costUsd: null, complete: true });
});
test("captures Responses usage and preserves unknown versus zero cost", () => {
  const c = createUsageCapture({ requestId: "r", provider: "litellm", costUsd: 0 });
  c.push(JSON.stringify({ response: { model: "x", usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 } } } }));
  const result = c.finish(true);
  assert.equal(result.cachedInputTokens, 30);
  assert.equal(result.costUsd, 0);
  assert.equal(result.complete, true);
});
test("missing usage and interrupted streams are not complete", () => {
  const c = createUsageCapture({ requestId: "r", provider: "x", costUsd: null });
  c.push('data: {"usage":{"output_tokens":2}}\n');
  assert.equal(c.finish(false).complete, false);
  assert.equal(createUsageCapture({ requestId: "r", provider: "x", costUsd: null }).finish(true).complete, false);
});
