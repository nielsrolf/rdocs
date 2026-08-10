import assert from "node:assert/strict";
import test from "node:test";

import {
  createBackgroundTaskTracker,
  describeBackgroundWork,
  scanContainerBackgroundProcesses
} from "../agent-core/background-work";

// --- SDK-stream tracking of background Bash tasks ---

function bashLaunch(id: string, command: string, background = true) {
  return {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id,
          name: "Bash",
          input: { command, ...(background ? { run_in_background: true } : {}) }
        }
      ]
    }
  };
}

function toolResult(toolUseId: string, text: string) {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] }
  };
}

test("a background Bash launch is pending until its completion notification", () => {
  const tracker = createBackgroundTaskTracker();
  tracker.observe(bashLaunch("toolu_1", "python train.py --epochs 5"));
  tracker.observe(toolResult("toolu_1", "Command running in background with task id: bash_3"));

  assert.equal(tracker.pending().length, 1);
  assert.match(tracker.pending()[0], /python train\.py/);

  // The completion arrives as a task-notification user message naming the id.
  tracker.observe({
    type: "user",
    message: {
      content: [{ type: "text", text: "<task-notification>Background task bash_3 completed (exit code 0)</task-notification>" }]
    }
  });
  assert.deepEqual(tracker.pending(), []);
});

test("foreground Bash calls are never tracked", () => {
  const tracker = createBackgroundTaskTracker();
  tracker.observe(bashLaunch("toolu_2", "ls -la", false));
  assert.deepEqual(tracker.pending(), []);
});

test("an unattributable notification clears nothing (over-report, never miss live work)", () => {
  const tracker = createBackgroundTaskTracker();
  tracker.observe(bashLaunch("toolu_3", "npm run build"));
  tracker.observe(toolResult("toolu_3", "Command running in background with task id: bash_7"));
  tracker.observe({
    type: "user",
    message: { content: [{ type: "text", text: "<task-notification>Background task bash_999 completed</task-notification>" }] }
  });
  assert.equal(tracker.pending().length, 1);
});

test("long commands are clipped in the pending description", () => {
  const tracker = createBackgroundTaskTracker();
  tracker.observe(bashLaunch("toolu_4", `python run.py ${"--flag ".repeat(60)}`));
  const [desc] = tracker.pending();
  assert.ok(desc.length < 180, `description should be clipped, got ${desc.length} chars`);
});

// --- container process scan ---

type FakeProc = { pid: number; ppid: number; cmdline: string; comm?: string };

function fakeProcFs(procs: FakeProc[]) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  return {
    readdirSync: () => [...byPid.keys()].map(String).concat(["self", "uptime"]),
    readFileSync: (path: string) => {
      const match = path.match(/\/(\d+)\/(stat|cmdline)$/);
      if (!match) throw new Error(`ENOENT: ${path}`);
      const proc = byPid.get(Number(match[1]));
      if (!proc) throw new Error(`ENOENT: ${path}`);
      if (match[2] === "stat") {
        return `${proc.pid} (${proc.comm ?? proc.cmdline.split(" ")[0].slice(0, 15)}) S ${proc.ppid} 1 1 0`;
      }
      return proc.cmdline.split(" ").join("\0") + "\0";
    }
  };
}

test("the scan separates agent infrastructure from real background work", () => {
  const fs = fakeProcFs([
    // Infra tree: entrypoint's node child running the claude CLI + its own children.
    { pid: 10, ppid: 1, cmdline: "node /app/node_modules/.bin/claude --print" },
    { pid: 11, ppid: 10, cmdline: "/bin/bash -c ls" },
    // Background work re-parented to PID 1 after nohup.
    { pid: 20, ppid: 1, cmdline: "python train.py --epochs 5" },
    { pid: 21, ppid: 20, cmdline: "python worker.py" }
  ]);
  const result = scanContainerBackgroundProcesses({ procRoot: "/proc", selfPid: 1, fs });
  assert.ok(result, "PID 1 with a readable /proc must scan");
  assert.deepEqual(
    result.map((p) => p.pid),
    [20],
    "only background TREE ROOTS are reported; infra and grandchildren are not"
  );
  assert.match(result[0].command, /train\.py/);
});

test("the scan is null when not PID 1 (host/in-process runs must not scan)", () => {
  const fs = fakeProcFs([{ pid: 20, ppid: 1, cmdline: "python train.py" }]);
  assert.equal(scanContainerBackgroundProcesses({ selfPid: 4242, fs }), null);
});

test("the scan is null when /proc is unavailable (macOS)", () => {
  const fs = {
    readdirSync: () => {
      throw new Error("ENOENT");
    },
    readFileSync: () => {
      throw new Error("ENOENT");
    }
  };
  assert.equal(scanContainerBackgroundProcesses({ selfPid: 1, fs }), null);
});

test("kernel threads and empty cmdlines are ignored", () => {
  const fs = fakeProcFs([{ pid: 30, ppid: 1, cmdline: "", comm: "kthreadd" }]);
  const result = scanContainerBackgroundProcesses({ selfPid: 1, fs });
  assert.deepEqual(result, []);
});

test("describeBackgroundWork merges both signals", () => {
  const tracker = createBackgroundTaskTracker();
  tracker.observe(bashLaunch("toolu_5", "npm run watch"));
  const out = describeBackgroundWork(tracker, [{ pid: 99, command: "python serve.py" }]);
  assert.equal(out.length, 2);
  assert.match(out[0], /npm run watch/);
  assert.match(out[1], /process 99: python serve\.py/);
});
