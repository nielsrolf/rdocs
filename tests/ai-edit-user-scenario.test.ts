import assert from "node:assert/strict";
import { test } from "node:test";

import { EditorState } from "@tiptap/pm/state";

import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import {
  createAiEditSelectionPlugin,
  getAiEditSelectionRange,
  removeAiEditSelection,
  upsertAiEditSelection,
} from "../components/document-workspace/ai-edit-selections";
import { buildAiEditRemountTransaction } from "../components/document-workspace/ai-edit-remount";
import { createSerialQueue } from "../components/document-workspace/serial-queue";

const schema = createDocumentEditorSchema();

// The user's exact document: each "Answer" / "Add here" placeholder is its OWN
// edit request. We anchor all of them first (parallel kickoff), then apply each
// run's result through the SAME serial queue and post-apply remount the live
// component uses, and print + assert each result landed in its own section.
function buildDoc() {
  const p = (text: string) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : undefined });
  return {
    type: "doc",
    content: [
      p("This is a test of the environment:"),
      p(""),
      p("What is the value of $foo ?"),
      p("Answer-foo"),
      p(""),
      p("What is the pwd?"),
      p("Answer-pwd"),
      p(""),
      p("Can you run ls ~?"),
      p("Answer-ls"),
      p(""),
      p("Can you add a sine plot (png created with matplotlib)?"),
      p("Add-here-plot"),
      p(""),
      p("Can you add a widget?"),
      p("Add-here-widget"),
    ],
  };
}

type Req = { id: string; placeholder: string; kind: "text" | "image" | "widget"; result: string };

// Distinct, recognizable results so we can verify each landed under its own question.
const REQUESTS: Req[] = [
  { id: "foo", placeholder: "Answer-foo", kind: "text", result: "RESULT_FOO=yoyoyo" },
  { id: "pwd", placeholder: "Answer-pwd", kind: "text", result: "RESULT_PWD=/repo/worktree-foo" },
  { id: "ls", placeholder: "Answer-ls", kind: "text", result: "RESULT_LS=Desktop Documents" },
  { id: "plot", placeholder: "Add-here-plot", kind: "image", result: "assets/sine_plot.png" },
  { id: "widget", placeholder: "Add-here-widget", kind: "widget", result: "Sine Explorer" },
];

function resultNode(req: Req) {
  if (req.kind === "image") {
    return schema.nodes.repoImage.create({
      src: `/api/documents/x/repo-files?path=${encodeURIComponent(req.result)}`,
      alt: req.result,
      caption: req.result,
      path: req.result,
    });
  }
  if (req.kind === "widget") {
    return schema.nodes.embeddedWidget.create({
      widgetId: "w1",
      documentId: "x",
      label: req.result,
      buildCmd: "python build.py",
      embedSource: "assets/w.html",
      src: "/api/x",
    });
  }
  return schema.text(req.result);
}

function findText(state: EditorState, needle: string): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  state.doc.descendants((node, pos) => {
    if (found || !node.isText || !node.text) return undefined;
    const idx = node.text.indexOf(needle);
    if (idx >= 0) found = { from: pos + idx, to: pos + idx + needle.length };
    return undefined;
  });
  return found;
}

// Mirrors applyAiEditRun for a single client: resolve the anchor, replace the
// selected placeholder with the agent's result, drop the anchor, then remount.
function applyRun(stateRef: { state: EditorState }, req: Req, lost: string[]) {
  const range = getAiEditSelectionRange(stateRef.state, req.id);
  if (!range) {
    lost.push(req.id);
    stateRef.state = stateRef.state.apply(removeAiEditSelection(stateRef.state, req.id));
    return;
  }
  // insertContentAt(replacementRange, result): replace the placeholder in place.
  // Text replaces inline; an image/widget block is fitted (paragraph split) just as
  // the live editor's insertContentAt does.
  const node = resultNode(req);
  stateRef.state = stateRef.state.apply(
    req.kind === "text"
      ? stateRef.state.tr.replaceWith(range.from, range.to, node)
      : stateRef.state.tr.replaceRangeWith(range.from, range.to, node)
  );
  stateRef.state = stateRef.state.apply(removeAiEditSelection(stateRef.state, req.id));
  const remount = buildAiEditRemountTransaction(stateRef.state);
  if (remount) stateRef.state = stateRef.state.apply(remount);
}

function describeBlock(node: { type: { name: string }; textContent: string; attrs?: Record<string, unknown> }): string {
  if (node.type.name === "repoImage") return `[image ${node.attrs?.path}]`;
  if (node.type.name === "embeddedWidget") return `[widget ${node.attrs?.label}]`;
  return node.textContent;
}

// Describes the block immediately AFTER the question paragraph.
function answerUnder(state: EditorState, question: string): string {
  const blocks: Array<{ type: { name: string }; textContent: string; attrs?: Record<string, unknown> }> = [];
  state.doc.forEach((node) => blocks.push(node as never));
  const qi = blocks.findIndex((n) => n.textContent.includes(question));
  return qi >= 0 && qi + 1 < blocks.length ? describeBlock(blocks[qi + 1]) : "<none>";
}

async function runScenario(applyOrder: Req[]) {
  const stateRef = {
    state: EditorState.create({ doc: schema.nodeFromJSON(buildDoc()), plugins: [createAiEditSelectionPlugin()] }),
  };

  // Parallel kickoff: anchor every placeholder before any result comes back.
  for (const req of REQUESTS) {
    const range = findText(stateRef.state, req.placeholder);
    assert.ok(range, `placeholder ${req.placeholder} must exist`);
    stateRef.state = stateRef.state.apply(
      upsertAiEditSelection(stateRef.state, { id: req.id, from: range!.from, to: range!.to, progress: "x" })
    );
  }

  // Results arrive and apply through the serial queue (the live ordering guarantee).
  const queue = createSerialQueue();
  const lost: string[] = [];
  await Promise.all(applyOrder.map((req) => queue.run(async () => applyRun(stateRef, req, lost))));

  return { state: stateRef.state, lost };
}

test("user scenario: five placeholder edits each land in their own section", async () => {
  // Apply in a different order than the document order, mimicking agents finishing
  // out of order (the user ran them in parallel).
  const order = [REQUESTS[2], REQUESTS[0], REQUESTS[4], REQUESTS[1], REQUESTS[3]];
  const { state, lost } = await runScenario(order);

  // Print the final document for manual verification.
  const lines: string[] = [];
  state.doc.forEach((node) => lines.push(describeBlock(node as never)));
  console.log("\n=== FINAL DOCUMENT STATE ===\n" + lines.join("\n") + "\n============================\n");

  assert.deepEqual(lost, [], `no edit should lose its anchor, lost: ${lost.join(", ")}`);

  // Each result must sit directly under its own question.
  assert.equal(answerUnder(state, "value of $foo"), "RESULT_FOO=yoyoyo");
  assert.equal(answerUnder(state, "What is the pwd?"), "RESULT_PWD=/repo/worktree-foo");
  assert.equal(answerUnder(state, "Can you run ls ~?"), "RESULT_LS=Desktop Documents");
  assert.equal(answerUnder(state, "sine plot"), "[image assets/sine_plot.png]");
  assert.equal(answerUnder(state, "Can you add a widget?"), "[widget Sine Explorer]");

  // No placeholder should survive (every request was applied in place).
  const fullText = state.doc.textContent;
  for (const req of REQUESTS) {
    assert.ok(!fullText.includes(req.placeholder), `placeholder ${req.placeholder} should have been replaced`);
  }
});
