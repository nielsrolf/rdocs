import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentSafetyRefusalError,
  isAuthFailure,
  isRetryableAgentError,
  retryWithBackoff,
  TRANSIENT_RETRY_DELAYS_MS
} from "../lib/ai";

test("isRetryableAgentError matches broadened transient API + container signals", () => {
  for (const message of [
    "fetch failed: ECONNRESET",
    "rate limited, try again",
    "overloaded",
    "API Error: 429 Too Many Requests",
    "API Error: 500 Internal Server Error",
    "upstream returned 502",
    "503 Service Unavailable",
    "API Error: 529 overloaded_error",
    "connect ECONNREFUSED 127.0.0.1:443",
    "agent container spawn failed: spawn docker ENOENT",
    "agent container exited without a result (exit code 137)."
  ]) {
    assert.equal(isRetryableAgentError(new Error(message)), true, message);
  }
});

test("isRetryableAgentError does NOT retry auth, refusal, validation, or hard timeouts", () => {
  assert.equal(isRetryableAgentError(new Error("API Error: 401 Invalid authentication credentials")), false);
  assert.equal(isRetryableAgentError(new Error("Failed to authenticate")), false);
  assert.equal(isRetryableAgentError(new AgentSafetyRefusalError("refused")), false);
  assert.equal(isRetryableAgentError(new Error("replacementText must not be empty")), false);
  assert.equal(isRetryableAgentError(new Error("Agent timed out after 600s")), false);
  assert.equal(isRetryableAgentError("not an error"), false);
  // 400 is a client error, not in the retryable set.
  assert.equal(isRetryableAgentError(new Error("API Error: 400 Bad Request")), false);
});

test("isAuthFailure classifies 401 / auth-credential errors and ignores others", () => {
  for (const message of [
    "Claude Code returned an error result: Failed to authenticate. API Error: 401 Invalid authentication credentials",
    "API Error: 401",
    "invalid authentication credentials",
    "OAuth token has expired",
    "authentication_error: invalid api key"
  ]) {
    assert.equal(isAuthFailure(new Error(message)), true, message);
  }
  assert.equal(isAuthFailure(new Error("API Error: 429 Too Many Requests")), false);
  assert.equal(isAuthFailure(new Error("fetch failed")), false);
  assert.equal(isAuthFailure(new Error("API Error: 500")), false);
  assert.equal(isAuthFailure(null), false);
});

test("retryWithBackoff retries retryable failures with the given schedule, then succeeds", async () => {
  const slept: number[] = [];
  const attempts: number[] = [];
  let calls = 0;
  const result = await retryWithBackoff(
    async (attempt) => {
      attempts.push(attempt);
      calls += 1;
      if (calls < 3) throw new Error("overloaded_error");
      return "ok";
    },
    {
      isRetryable: isRetryableAgentError,
      delaysMs: [2_000, 8_000],
      sleep: async (ms) => {
        slept.push(ms);
      }
    }
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3, "initial try + 2 retries");
  assert.deepEqual(attempts, [0, 1, 2]);
  assert.deepEqual(slept, [2_000, 8_000], "exponential-ish backoff between retries");
});

test("retryWithBackoff rethrows after exhausting the retry budget", async () => {
  const slept: number[] = [];
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => {
        calls += 1;
        throw new Error("overloaded_error");
      },
      { isRetryable: isRetryableAgentError, delaysMs: [1, 1], sleep: async (ms) => void slept.push(ms) }
    ),
    /overloaded_error/
  );
  assert.equal(calls, 3, "initial try + 2 retries then give up");
  assert.equal(slept.length, 2);
});

test("retryWithBackoff does not retry a non-retryable error", async () => {
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => {
        calls += 1;
        throw new Error("API Error: 401 Invalid authentication credentials");
      },
      { isRetryable: isRetryableAgentError, delaysMs: [1, 1], sleep: async () => {} }
    ),
    /401/
  );
  assert.equal(calls, 1, "auth failure is thrown immediately");
});

test("TRANSIENT_RETRY_DELAYS_MS is a two-step escalating backoff", () => {
  assert.equal(TRANSIENT_RETRY_DELAYS_MS.length, 2);
  assert.ok(TRANSIENT_RETRY_DELAYS_MS[1] > TRANSIENT_RETRY_DELAYS_MS[0]);
});
