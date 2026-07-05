import assert from "node:assert/strict";
import test from "node:test";

import { EditorState } from "@tiptap/pm/state";

import {
  cleanupStaleAiEditRangeMarksAfterRunsLoaded,
  createAiEditSelectionPlugin,
  resolveAiEditApplyRange,
  upsertAiEditSelection
} from "../components/document-workspace/ai-edit-selections";
import type { ActiveAiRunView } from "../components/document-workspace/types";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";

// Regression: when a SUCCEEDED run's selection anchor was gone (e.g. the
// false-"abandoned" failure path had already stripped the aiEditRange marker
// before the run actually finished), applyAiEditRun claimed the run as applied
// WITHOUT inserting anything — hours of agent work silently vanished, while the
// document showed no trace of it. A lost anchor must degrade to a visible
// fallback insertion point (end of document), never to dropping the result.

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

test("an intact anchor resolves to its exact range", () => {
  let state = stateWithText("Hello brave world");
  state = state.apply(upsertAiEditSelection(state, { id: "sel-1", from: 7, to: 12 }));

  const resolved = resolveAiEditApplyRange(state, "sel-1");

  assert.deepEqual(resolved, { from: 7, to: 12, anchorLost: false });
});

test("a lost anchor resolves to an end-of-document insertion point, not null", () => {
  // No marker was ever tracked in this editor state (mirrors the real flow:
  // the failure toast cleared the mark, then the doc was reloaded).
  const state = stateWithText("Hello brave world");

  const resolved = resolveAiEditApplyRange(state, "sel-gone");

  const end = state.doc.content.size;
  assert.deepEqual(
    resolved,
    { from: end, to: end, anchorLost: true },
    "the run result must still get an insertion point so it is never dropped"
  );
});

// Regression: the mount-time stale-mark sweep used to fire as soon as the
// editor existed, with the polled run list still empty — so it protected
// nothing and stripped EVERY aiEditRange mark, including the anchor of a
// SUCCEEDED-but-unapplied run. Every fresh page load then applied that run as
// "marker lost". The sweep must wait for the first server run list.

function markedState(selectionId: string) {
  const state = EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              marks: [{ type: "aiEditRange", attrs: { selectionIds: [selectionId] } }],
              text: "Results"
            }
          ]
        }
      ]
    }),
    plugins: [createAiEditSelectionPlugin()]
  });
  return state;
}

function succeededUnappliedRun(selectionId: string): ActiveAiRunView {
  return {
    id: "run-1",
    triggerType: "SELECTION_EDIT",
    selectionId,
    instruction: "test",
    status: "SUCCEEDED",
    progress: null,
    startedAt: new Date().toISOString(),
    appliedAt: null
  };
}

test("the sweep does nothing before the first run list has loaded", () => {
  const state = markedState("sel-keep");

  const tr = cleanupStaleAiEditRangeMarksAfterRunsLoaded(state, [], false);

  assert.equal(tr, null, "no sweep may run against the pre-poll empty run list");
  assert.ok(resolveAiEditApplyRange(state, "sel-keep").anchorLost === false, "anchor must survive");
});

test("once runs are loaded, an unapplied succeeded run's anchor is protected", () => {
  let state = markedState("sel-keep");

  const tr = cleanupStaleAiEditRangeMarksAfterRunsLoaded(state, [succeededUnappliedRun("sel-keep")], true);

  if (tr) state = state.apply(tr);
  assert.equal(
    resolveAiEditApplyRange(state, "sel-keep").anchorLost,
    false,
    "the unapplied run's anchor must not be swept"
  );
});

test("once runs are loaded, a truly orphaned mark is swept", () => {
  let state = markedState("sel-orphan");

  const tr = cleanupStaleAiEditRangeMarksAfterRunsLoaded(state, [], true);

  assert.ok(tr, "orphaned mark should produce a cleanup transaction");
  state = state.apply(tr!);
  assert.equal(resolveAiEditApplyRange(state, "sel-orphan").anchorLost, true, "orphan mark removed");
});

test("a marker removed by a concurrent full-range deletion still resolves via its collapsed anchor", () => {
  // The plugin collapses a deleted range to a zero-width point — that is an
  // intact anchor, not a lost one, and must win over the end-of-doc fallback.
  let state = stateWithText("Hello brave world");
  state = state.apply(upsertAiEditSelection(state, { id: "sel-1", from: 7, to: 12 }));
  state = state.apply(state.tr.delete(7, 13));

  const resolved = resolveAiEditApplyRange(state, "sel-1");

  assert.equal(resolved.anchorLost, false);
  assert.equal(resolved.from, resolved.to, "deleted range collapses to a zero-width point");
  assert.ok(resolved.from <= state.doc.content.size);
});
