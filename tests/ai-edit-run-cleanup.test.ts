import assert from "node:assert/strict";
import test from "node:test";

import { EditorState } from "@tiptap/pm/state";

import {
  aiEditSelectionIdsToProtect,
  cleanupStaleAiEditRangeMarks,
  createAiEditSelectionPlugin,
  getAiEditSelectionRange,
  syncAiEditSelectionRuns,
  upsertAiEditSelection
} from "../components/document-workspace/ai-edit-selections";
import type { ActiveAiRunView } from "../components/document-workspace/types";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";

// Regression coverage for the "succeeded run's result silently skipped" incident:
// a SELECTION_EDIT run finished while no editor session was watching; the next
// session's mount-time stale-mark cleanup treated the (SUCCEEDED, not yet
// applied) run's marker as stale and deleted it, so the apply found no anchor,
// logged ai-edit-marker-lost, and claimed the run via markApplied — the
// replacement never reached the document. Companion bug: the tab that kicked
// the run off keeps its plugin-state entry (source "local") forever, showing
// the "Claude is working" shimmer for a run that is long done.

const schema = createDocumentEditorSchema();

function stateWithText(text: string) {
  return EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }]
    }),
    plugins: [createAiEditSelectionPlugin()]
  });
}

function makeRun(overrides: Partial<ActiveAiRunView>): ActiveAiRunView {
  return {
    id: "run-1",
    triggerType: "SELECTION_EDIT",
    triggerId: "selection:sel-1",
    selectionId: "sel-1",
    instruction: "Rewrite it",
    status: "RUNNING",
    progress: null,
    startedAt: new Date("2026-07-05T14:44:00Z"),
    finishedAt: null,
    appliedAt: null,
    ...overrides
  };
}

// A fresh editor session: the doc still carries the aiEditRange mark, but the
// plugin state is empty (it lives in memory and does not survive a remount).
function remountedStateWithMark() {
  let state = stateWithText("Hello brave world");
  state = state.apply(upsertAiEditSelection(state, { id: "sel-1", from: 7, to: 12, runId: "run-1" }));
  return EditorState.create({ doc: state.doc, plugins: [createAiEditSelectionPlugin()] });
}

test("mount cleanup keeps the marker of a SUCCEEDED run whose result is not applied yet", () => {
  let state = remountedStateWithMark();
  const runs = [makeRun({ status: "SUCCEEDED", finishedAt: new Date("2026-07-05T14:48:00Z"), appliedAt: null })];

  const cleanupTr = cleanupStaleAiEditRangeMarks(state, aiEditSelectionIdsToProtect(runs));
  if (cleanupTr) state = state.apply(cleanupTr);

  assert.deepEqual(
    getAiEditSelectionRange(state, "sel-1"),
    { from: 7, to: 12 },
    "the anchor must survive so the pending replacement can still be inserted"
  );
});

test("mount cleanup keeps the marker of a RUNNING run", () => {
  let state = remountedStateWithMark();
  const runs = [makeRun({ status: "RUNNING" })];

  const cleanupTr = cleanupStaleAiEditRangeMarks(state, aiEditSelectionIdsToProtect(runs));
  if (cleanupTr) state = state.apply(cleanupTr);

  assert.deepEqual(getAiEditSelectionRange(state, "sel-1"), { from: 7, to: 12 });
});

test("mount cleanup removes the marker of a SUCCEEDED run that was already applied", () => {
  let state = remountedStateWithMark();
  const runs = [
    makeRun({
      status: "SUCCEEDED",
      finishedAt: new Date("2026-07-05T14:48:00Z"),
      appliedAt: new Date("2026-07-05T14:57:49Z")
    })
  ];

  const cleanupTr = cleanupStaleAiEditRangeMarks(state, aiEditSelectionIdsToProtect(runs));
  if (cleanupTr) state = state.apply(cleanupTr);

  assert.equal(getAiEditSelectionRange(state, "sel-1"), null);
});

test("mount cleanup removes the marker of a FAILED run from a previous session", () => {
  let state = remountedStateWithMark();
  const runs = [makeRun({ status: "FAILED", finishedAt: new Date("2026-07-05T14:48:00Z") })];

  const cleanupTr = cleanupStaleAiEditRangeMarks(state, aiEditSelectionIdsToProtect(runs));
  if (cleanupTr) state = state.apply(cleanupTr);

  assert.equal(getAiEditSelectionRange(state, "sel-1"), null);
});

test("syncRuns prunes the lingering local entry of a run that finished and was applied elsewhere", () => {
  // Tab A kicks off the run: mark + plugin entry (source "local").
  let state = stateWithText("Hello brave world");
  state = state.apply(upsertAiEditSelection(state, { id: "sel-1", from: 7, to: 12, runId: "run-1" }));

  // Another session applies the run (or claims it after marker loss) and its
  // mark-removal step arrives via collab. Tab A's plugin entry survives that —
  // only the mark is gone.
  const cleanupTr = cleanupStaleAiEditRangeMarks(state, new Set());
  assert.ok(cleanupTr, "the remote cleanup step removes the mark");
  state = state.apply(cleanupTr!);
  assert.ok(getAiEditSelectionRange(state, "sel-1"), "plugin entry still anchors (and decorates) the range");

  // Tab A's next runs poll reports the run as settled (SUCCEEDED + appliedAt).
  state = state.apply(syncAiEditSelectionRuns(state, [], ["sel-1"]));

  assert.equal(
    getAiEditSelectionRange(state, "sel-1"),
    null,
    "the settled run's entry must be dropped so the working shimmer disappears"
  );
});

test("syncRuns keeps local entries that are not settled", () => {
  let state = stateWithText("Hello brave world");
  state = state.apply(upsertAiEditSelection(state, { id: "sel-1", from: 7, to: 12, runId: "run-1" }));

  state = state.apply(syncAiEditSelectionRuns(state, [], []));

  assert.deepEqual(getAiEditSelectionRange(state, "sel-1"), { from: 7, to: 12 });
});
