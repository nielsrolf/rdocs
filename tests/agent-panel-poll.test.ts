import assert from "node:assert/strict";
import test from "node:test";

import { aiRunsFingerprint, selectionBlocksRunSync } from "../components/document-workspace/conversations";
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

// Regression: even with the fingerprint skip, a genuinely-changed poll (new
// events streaming in every ~2s during a run) re-rendered the timeline and
// destroyed any in-progress text selection, so streamed output could not be
// copied. Run-list updates must be deferred while a real selection is anchored
// inside the agent view.
test("run sync is deferred only while a non-collapsed selection is anchored inside the panel", () => {
  const inPanel = Symbol("node-inside-panel");
  const outside = Symbol("node-outside-panel");
  const panelRoot = { contains: (node: unknown) => node === inPanel };

  // The case that ate the user's selection: selecting streamed output.
  assert.equal(selectionBlocksRunSync({ isCollapsed: false, anchorNode: inPanel }, panelRoot), true);

  // Everything else must NOT block updates:
  assert.equal(selectionBlocksRunSync({ isCollapsed: true, anchorNode: inPanel }, panelRoot), false, "a caret is not a selection");
  assert.equal(selectionBlocksRunSync({ isCollapsed: false, anchorNode: outside }, panelRoot), false, "selecting in the document editor");
  assert.equal(selectionBlocksRunSync({ isCollapsed: false, anchorNode: null }, panelRoot), false, "no anchor node");
  assert.equal(selectionBlocksRunSync(null, panelRoot), false, "no selection object");
  assert.equal(selectionBlocksRunSync({ isCollapsed: false, anchorNode: inPanel }, null), false, "panel closed");
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
