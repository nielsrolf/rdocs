import assert from "node:assert/strict";
import test from "node:test";

import { buildTrajectoryOutline, describeShellCommand } from "../components/document-workspace/trajectory-outline";
import type { AiRunEventView } from "../components/document-workspace/types";

let seq = 0;
function ev(role: string, message: string, gapMs = 1000): AiRunEventView {
  seq += gapMs;
  return { id: `ev-${seq}`, role, message, createdAt: new Date(1700000000000 + seq).toISOString() } as AiRunEventView;
}

test("the trajectory outline: messages are headings, tool work is folded underneath", () => {
  const entries = buildTrajectoryOutline(
    [
      ev("user", "Run the eval.\nMore detail."),
      ev("system", "Using isolated worktree /x on branch y."),
      ev("tool", 'Read: {"file_path":"/workspace/a.py"}'),
      ev("tool_result", "a"),
      ev("tool", 'Grep: {"pattern":"foo"}'),
      ev("tool_result", "b"),
      ev("tool", 'TodoWrite: {"todos":[{"content":"x","status":"pending"}]}'),
      ev("tool_result", "ok"),
      ev("tool", `Bash: ${JSON.stringify({ command: "cd /workspace && cat > run_eval.py <<'EOF'\nprint(1)\nEOF" })}`),
      ev("tool_result", '{"stdout":""}'),
      ev("tool", 'Bash: {"command":"python run_eval.py","description":"Run the evaluation"}'),
      ev("tool", "Using Bash.", 30_000),
      ev("tool_result", "Error: Exit code 1", 30_000),
      ev("agent", "**Fixing** the parser."),
      ev("tool", 'Edit: {"file_path":"/workspace/run_eval.py","old_string":"a","new_string":"b"}'),
      ev("tool_result", "ok"),
      ev("tool", 'Edit: {"file_path":"/workspace/run_eval.py","old_string":"c","new_string":"d"}'),
      ev("tool_result", "ok")
    ],
    false
  );
  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.label, entry.hint ?? null, Boolean(entry.failed)]),
    [
      ["prompt", "Run the eval.", null, false],
      ["action", "Explored 2 files", null, false],
      ["action", "Write run_eval.py", null, false],
      ["action", "Run the evaluation", "1m 00s", true],
      ["agent", "Fixing the parser.", null, false],
      ["action", "Edit run_eval.py", "×2", false]
    ]
  );
});

test("shell commands are summarized by what they do", () => {
  assert.equal(describeShellCommand("cd /workspace/results; python3 analyze.py"), "python3 analyze.py");
  assert.equal(describeShellCommand("mkdir -p out && cat > out/tasks.py <<'EOF'\nx\nEOF\npython out/tasks.py"), "Write tasks.py");
  assert.equal(describeShellCommand("sleep 240; cat log.txt"), "sleep 240; cat log.txt");
  assert.equal(describeShellCommand("cd results; python3 - <<'EOF'\nimport json\nEOF"), "python3: import json");
  assert.equal(describeShellCommand('python3 -c "\nprint(raw_ablation)\n"'), "python3: print(raw_ablation)");
});

test("outline markers: model sections where present, every prompt kept, tool tallies per stretch", async () => {
  const { buildOutlineMarkers } = await import("../components/document-workspace/agent-todo-outline");
  let n = 0;
  const e = (role: string, message: string) => {
    n += 1;
    return { id: `m${n}`, role, message, createdAt: new Date(1_700_000_000_000 + n * 1000).toISOString() };
  };
  const events = [
    e("user", "Run the eval"), // m1
    e("tool", 'Bash: {"command":"pip install x"}'), // m2
    e("tool_result", "Error: Exit code 1"),
    e("tool", 'Bash: {"command":"pip install --user x"}'), // m4
    e("tool_result", '{"stdout":"ok","stderr":""}'),
    e("agent", "Installed."), // m6
    e("tool", 'Write: {"file_path":"/w/run.py","content":"x"}'), // m7
    e("tool_result", "ok"),
    e("user", "Also plot it"), // m9
    e("tool", 'Bash: {"command":"python plot.py"}'), // m10
    e("tool_result", '{"stdout":"ok","stderr":""}'),
    e("agent", "Done.") // m12
  ];
  // No model outline: the rule-based headings (messages), never one marker per tool call.
  const fallback = buildOutlineMarkers(events, [], false);
  assert.deepEqual(fallback.map((marker) => marker.anchorEventId), ["m1", "m6", "m9", "m12"]);
  assert.deepEqual(fallback.map((marker) => [marker.toolCalls, marker.failed]), [[2, 1], [1, 0], [1, 0], [0, 0]]);

  // Model sections replace the agent headings; a prompt they do not start at stays; unknown anchors are dropped.
  const markers = buildOutlineMarkers(
    events,
    [
      { startEventId: "m1", title: "Install dependencies" },
      { startEventId: "m7", title: "Write the eval script" },
      { startEventId: "gone", title: "Not loaded" }
    ],
    false
  );
  assert.deepEqual(
    markers.map((marker) => [marker.kind, marker.title, marker.toolCalls, marker.failed]),
    [
      ["section", "Install dependencies", 2, 1],
      ["section", "Write the eval script", 1, 0],
      ["prompt", "Also plot it", 1, 0]
    ]
  );
});
