import assert from "node:assert/strict";
import test from "node:test";

import { buildTodoOutline, parseTodoSnapshot } from "../components/document-workspace/todo-outline";
import type { AiRunEventView } from "../components/document-workspace/types";

let seq = 0;
function ev(role: string, message: string): AiRunEventView {
  seq += 1;
  return {
    id: `ev-${seq}`,
    role,
    message,
    createdAt: new Date(1700000000000 + seq * 1000).toISOString()
  } as AiRunEventView;
}

function todoEvent(todos: Array<Record<string, unknown>>) {
  return ev("tool", `TodoWrite: ${JSON.stringify({ todos })}`);
}

test("parseTodoSnapshot reads Claude and Codex todo shapes", () => {
  assert.deepEqual(
    parseTodoSnapshot('TodoWrite: {"todos":[{"content":"Read code","status":"completed","activeForm":"Reading"}]}'),
    [{ content: "Read code", status: "completed" }]
  );
  assert.deepEqual(parseTodoSnapshot('TodoWrite: {"todos":[{"text":"Plan it","completed":false}]}'), [
    { content: "Plan it", status: "pending" }
  ]);
  assert.equal(parseTodoSnapshot('Bash: {"command":"ls"}'), null);
});

test("parseTodoSnapshot recovers todos from a payload clipped mid-JSON", () => {
  const full = JSON.stringify({
    todos: [
      { content: "Reproduce the bug", status: "completed", activeForm: "Reproducing the bug" },
      { content: "Fix the parser", status: "in_progress", activeForm: "Fixing the parser" },
      { content: "Run the suite", status: "pending", activeForm: "Running the suite" }
    ]
  });
  const clipped = `TodoWrite: ${full.slice(0, full.length - 40)}...`;
  const items = parseTodoSnapshot(clipped);
  assert.ok(items);
  assert.deepEqual(items!.slice(0, 2), [
    { content: "Reproduce the bug", status: "completed" },
    { content: "Fix the parser", status: "in_progress" }
  ]);
});

test("buildTodoOutline folds snapshots into one outline with the current step", () => {
  const first = todoEvent([
    { content: "Read code", status: "in_progress" },
    { content: "Write test", status: "pending" }
  ]);
  const noise = ev("tool", 'Bash: {"command":"npm test"}');
  const second = todoEvent([
    { content: "Read code", status: "completed" },
    { content: "Write test", status: "in_progress" },
    { content: "Ship it", status: "pending" }
  ]);
  const outline = buildTodoOutline([first, noise, second]);

  assert.deepEqual(
    outline.items.map((item) => [item.content, item.status, item.current]),
    [
      ["Read code", "completed", false],
      ["Write test", "in_progress", true],
      ["Ship it", "pending", false]
    ]
  );
  assert.equal(outline.snapshots, 2);
  assert.equal(outline.done, 1);
  // Anchors point at the snapshot where the status was reached.
  assert.equal(outline.items[0].anchorEventId, second.id);
  assert.equal(outline.items[1].anchorEventId, second.id);
  assert.equal(outline.items[2].anchorEventId, second.id);
});

test("buildTodoOutline follows the newest plan ordering and keeps dropped todos", () => {
  const first = todoEvent([
    { content: "Alpha", status: "completed" },
    { content: "Dropped", status: "pending" }
  ]);
  const second = todoEvent([
    { content: "Beta", status: "completed" },
    { content: "Alpha", status: "completed" },
    { content: "Gamma", status: "pending" }
  ]);
  const outline = buildTodoOutline([first, second]);
  assert.deepEqual(outline.items.map((item) => item.content), ["Beta", "Alpha", "Gamma", "Dropped"]);
  // No in_progress entry: the first unfinished step is the current one (Codex-style plans).
  assert.deepEqual(outline.items.filter((item) => item.current).map((item) => item.content), ["Gamma"]);
});

test("buildTodoOutline returns an empty outline when the session has no todos", () => {
  const outline = buildTodoOutline([ev("agent", "hello"), ev("tool", 'Read: {"file_path":"a.ts"}')]);
  assert.deepEqual(outline.items, []);
  assert.equal(outline.snapshots, 0);
});
