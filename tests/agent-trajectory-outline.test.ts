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
});
