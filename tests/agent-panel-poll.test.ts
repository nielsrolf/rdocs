import assert from "node:assert/strict";
import test from "node:test";

import { aiRunsFingerprint } from "../components/document-workspace/conversations";
import type { ActiveAiRunView } from "../components/document-workspace/types";

// Regression: every 2s document poll produced fresh run/event object
// identities, so state was re-set (and the agent view re-rendered) even when
// nothing changed — yanking auto-scroll and disturbing in-progress text
// selection. syncAiRuns now fingerprints the payload and skips no-op polls.

function run(overrides: Partial<ActiveAiRunView> = {}): ActiveAiRunView {
  return {
    id: "run-1",
    triggerType: "SELECTION_EDIT",
    instruction: "do the thing",
    status: "SUCCEEDED",
    progress: "Done.",
    startedAt: "2026-07-05T12:00:00.000Z",
    events: [{ id: "e1", role: "agent", message: "hello", createdAt: "2026-07-05T12:00:01.000Z" }],
    ...overrides
  };
}

test("identical content with fresh object identities fingerprints identically", () => {
  assert.equal(aiRunsFingerprint([run()]), aiRunsFingerprint([run()]));
});

test("any content change fingerprints differently", () => {
  const base = aiRunsFingerprint([run()]);
  assert.notEqual(aiRunsFingerprint([run({ status: "RUNNING" })]), base);
  assert.notEqual(aiRunsFingerprint([run({ progress: "Working…" })]), base);
  assert.notEqual(
    aiRunsFingerprint([
      run({
        events: [
          { id: "e1", role: "agent", message: "hello", createdAt: "2026-07-05T12:00:01.000Z" },
          { id: "e2", role: "tool", message: "Bash: ls", createdAt: "2026-07-05T12:00:02.000Z" }
        ]
      })
    ]),
    base
  );
  assert.notEqual(aiRunsFingerprint([]), base);
});
