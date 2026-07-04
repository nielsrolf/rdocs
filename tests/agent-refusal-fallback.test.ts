import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentSafetyRefusalError,
  isSafetyRefusalError,
  isSafetyRefusalFailure,
  isSafetyRefusalMessage
} from "../lib/ai";

// Verbatim message the Claude Code runtime emits when the API returns
// stop_reason "refusal" (safety-classifier block, e.g. on claude-fable-5).
// Extracted from the bundled runtime binary — keep in sync if the runtime
// rewords it.
const RUNTIME_REFUSAL_MESSAGE =
  "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup).\n" +
  "Try rephrasing the request or attempting a different approach.\n" +
  "Request ID: req_011CSHoEeqs5C35K2UUqR7Fy";

test("isSafetyRefusalMessage matches the runtime's Usage-Policy refusal text", () => {
  assert.equal(isSafetyRefusalMessage(RUNTIME_REFUSAL_MESSAGE), true);
  // Variant without the leading prefix / with different casing.
  assert.equal(
    isSafetyRefusalMessage("this request appears to violate our usage policy"),
    true
  );
});

test("isSafetyRefusalMessage ignores ordinary agent failures", () => {
  assert.equal(isSafetyRefusalMessage("Claude research agent failed."), false);
  assert.equal(isSafetyRefusalMessage("fetch failed: ECONNRESET"), false);
  assert.equal(isSafetyRefusalMessage("overloaded_error: try again later"), false);
  assert.equal(isSafetyRefusalMessage("Max turns reached (8)"), false);
  // A document that merely talks about usage policies isn't a refusal.
  assert.equal(
    isSafetyRefusalMessage("Our usage policy allows requests of any kind."),
    false
  );
});

test("isSafetyRefusalError recognizes the typed error, including marker-only copies", () => {
  const error = new AgentSafetyRefusalError(RUNTIME_REFUSAL_MESSAGE);
  assert.equal(isSafetyRefusalError(error), true);
  assert.equal(error.name, "AgentSafetyRefusalError");

  // Errors that crossed a serialization boundary keep working via the marker.
  const marked = Object.assign(new Error("refused"), { isSafetyRefusal: true });
  assert.equal(isSafetyRefusalError(marked), true);

  assert.equal(isSafetyRefusalError(new Error("boom")), false);
  assert.equal(isSafetyRefusalError("refusal"), false);
  assert.equal(isSafetyRefusalError(null), false);
});

// Regression: the SDK does not always yield the error result message to the
// consumer loop. When the runtime subprocess exits after a refusal, the SDK
// replaces the exit error with a *thrown* plain Error prefixed with
// "Claude Code returned an error result: ..." (Query.readMessages). The first
// fallback implementation only matched the typed AgentSafetyRefusalError built
// from the result message, so this thrown shape sailed past the fallback and
// killed the run (observed live on aiRun cmr6h5fzt0001dhkidzq4b8bu, 2026-07-04).
const SDK_THROWN_REFUSAL =
  "Claude Code returned an error result: API Error: Claude Code is unable to respond to this request, " +
  "which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). " +
  "Try rephrasing the request or attempting a different approach. Request ID: req_011CchCWo2u8UGmonExae3Gy";

test("isSafetyRefusalFailure catches the SDK's thrown refusal error, not just the typed one", () => {
  assert.equal(isSafetyRefusalFailure(new Error(SDK_THROWN_REFUSAL)), true);
  assert.equal(isSafetyRefusalFailure(new AgentSafetyRefusalError("refused")), true);

  assert.equal(isSafetyRefusalFailure(new Error("Claude Code returned an error result: Max turns reached")), false);
  assert.equal(isSafetyRefusalFailure(new Error("fetch failed: ECONNRESET")), false);
  assert.equal(isSafetyRefusalFailure("not an error"), false);
  assert.equal(isSafetyRefusalFailure(null), false);
});
