import assert from "node:assert/strict";
import test from "node:test";

import { channelRunMessageSchema } from "../lib/agent-channel-runs";

// POST /api/agent-channels/:triggerId/runs — payload validation. The route
// trims the message before starting the run, so validation must trim first or
// a whitespace-only body passes `min(1)` and starts a run with an empty
// instruction (reported by the Callbridge integration, 2026-09-05).
test("channel run payload: whitespace-only messages are rejected, not started empty", () => {
  assert.equal(channelRunMessageSchema.safeParse({ message: "   \n\t " }).success, false);
  assert.equal(channelRunMessageSchema.safeParse({ message: "" }).success, false);
  const ok = channelRunMessageSchema.safeParse({ message: "  hello  " });
  assert.equal(ok.success, true);
  if (ok.success) assert.equal(ok.data.message, "hello");
});

test("channel run payload: previousRunId is optional and nullable", () => {
  assert.deepEqual(channelRunMessageSchema.parse({ message: "hi" }), { message: "hi" });
  assert.equal(channelRunMessageSchema.parse({ message: "hi", previousRunId: null }).previousRunId, null);
  assert.equal(channelRunMessageSchema.parse({ message: "hi", previousRunId: "abc" }).previousRunId, "abc");
  assert.equal(channelRunMessageSchema.safeParse({ message: "hi", previousRunId: "" }).success, false);
});
