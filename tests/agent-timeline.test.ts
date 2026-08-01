import assert from "node:assert/strict";
import test from "node:test";

import {
  extractJsonStringField,
  extractToolDiff,
  findFinalReplyIndex,
  groupAgentEvents,
  lifecycleStepLabel,
  parseToolMessage,
  parseToolResultData,
  toolDisplayName
} from "../components/document-workspace/agent-timeline";
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

test("toolDisplayName prettifies MCP tool names", () => {
  assert.equal(toolDisplayName("mcp__gdocs__post_slack_message"), "gdocs: post slack message");
  assert.equal(toolDisplayName("mcp__rdocs__read_document"), "rdocs: read document");
  assert.equal(toolDisplayName("Bash"), "Bash");
});

test("extractToolDiff reads Edit / MultiEdit / Write payloads", () => {
  const edit = parseToolMessage('Edit: {"file_path":"a.ts","old_string":"foo","new_string":"bar"}');
  assert.ok(edit);
  assert.deepEqual(extractToolDiff(edit!), {
    filePath: "a.ts",
    edits: [{ oldText: "foo", newText: "bar" }]
  });

  const multi = parseToolMessage(
    'MultiEdit: {"file_path":"a.ts","edits":[{"old_string":"x","new_string":"y"},{"old_string":"p","new_string":"q"}]}'
  );
  assert.ok(multi);
  assert.equal(extractToolDiff(multi!)?.edits.length, 2);

  const write = parseToolMessage('Write: {"file_path":"b.ts","content":"hello"}');
  assert.ok(write);
  assert.deepEqual(extractToolDiff(write!)?.edits, [{ oldText: "", newText: "hello" }]);

  // Path-only summaries from older runs have no diff payload — no diff block.
  const legacy = parseToolMessage('Edit: {"file_path":"a.ts"}');
  assert.ok(legacy);
  assert.equal(extractToolDiff(legacy!), null);
});

test("lifecycle plumbing becomes step rows, not prose", () => {
  assert.equal(lifecycleStepLabel("Starting Claude research agent."), "Run started");
  assert.equal(lifecycleStepLabel("Submitting final response."), "Submitting final response");
  assert.equal(lifecycleStepLabel("Preparing document update."), "Finishing up");
  assert.equal(lifecycleStepLabel("Some other system note."), null);

  const grouped = groupAgentEvents([
    ev("system", "Starting Claude research agent."),
    ev("agent", "Check-in posted."),
    ev("system", "Submitting final response."),
    ev("system", "Preparing document update."),
    ev("agent", "Good morning! Quick check-in.")
  ]);
  assert.deepEqual(
    grouped.map((g) => g.kind),
    ["step", "message", "step", "step", "message"]
  );
});

test("consecutive duplicate events are collapsed", () => {
  const grouped = groupAgentEvents([
    ev("system", "Submitting final response."),
    ev("system", "Submitting final response."),
    ev("agent", "Done.")
  ]);
  assert.equal(grouped.length, 2);
});

test("final reply after submit step is badged; interim commentary is not", () => {
  const grouped = groupAgentEvents([
    ev("user", "Please check in."),
    ev("agent", "Check-in posted."),
    ev("system", "Submitting final response."),
    ev("system", "Preparing document update."),
    ev("agent", "Good morning! Quick check-in for Thursday.")
  ]);
  const idx = findFinalReplyIndex(grouped, false);
  assert.equal(idx, grouped.length - 1);
  const item = grouped[idx];
  assert.ok(item.kind === "message" && item.event.message.startsWith("Good morning!"));

  // Still streaming: nothing is final yet.
  assert.equal(findFinalReplyIndex(grouped, true), -1);

  // A follow-up user message after the submit invalidates the badge.
  const withFollowUp = groupAgentEvents([
    ev("system", "Submitting final response."),
    ev("agent", "First reply."),
    ev("user", "Follow-up question"),
    ev("agent", "Streaming answer…")
  ]);
  assert.equal(findFinalReplyIndex(withFollowUp, false), -1);
});

// --- tool_result payload parsing (the data historical runs already have) ---

test("parseToolResultData reads Read results into a file view", () => {
  const message = JSON.stringify({
    type: "text",
    file: { filePath: "app/globals.css", content: "line one\nline two", numLines: 2, startLine: 794, totalLines: 5000 }
  });
  const data = parseToolResultData("Read", message);
  assert.deepEqual(data, {
    kind: "file",
    filePath: "app/globals.css",
    content: "line one\nline two",
    startLine: 794,
    truncated: false
  });
});

test("parseToolResultData reads Bash stdout/stderr", () => {
  const data = parseToolResultData("Bash", JSON.stringify({ stdout: "ok\ndone", stderr: "warning" }));
  assert.deepEqual(data, { kind: "bash", stdout: "ok\ndone", stderr: "warning", truncated: false });
});

test("parseToolResultData reads Edit results as a diff", () => {
  const data = parseToolResultData(
    "Edit",
    JSON.stringify({ filePath: "CLAUDE.md", oldString: "old text", newString: "new text", replaceAll: false })
  );
  assert.deepEqual(data, {
    kind: "editResult",
    filePath: "CLAUDE.md",
    oldText: "old text",
    newText: "new text",
    truncated: false
  });
});

test("parseToolResultData survives payloads clipped mid-JSON", () => {
  const full = JSON.stringify({
    type: "text",
    file: { filePath: "a.ts", content: "alpha\nbeta\ngamma delta epsilon", startLine: 10 }
  });
  // Clip inside the content string, like the 1400-char event cap does.
  const clipped = full.slice(0, full.indexOf("gamma") + 3);
  const data = parseToolResultData("Read", clipped);
  assert.ok(data && data.kind === "file");
  assert.equal(data.filePath, "a.ts");
  // startLine serializes after content, so it is lost with the clip — the
  // renderer falls back to the Read call's offset arg in that case.
  assert.equal(data.startLine, 1);
  assert.ok(data.content.startsWith("alpha\nbeta\ngam"));
  assert.equal(data.truncated, true);

  const bashClipped = JSON.stringify({ stdout: "hello world this is output" }).slice(0, 25);
  const bash = parseToolResultData("Bash", bashClipped);
  assert.ok(bash && bash.kind === "bash" && bash.stdout.startsWith("hello"));
  assert.equal(bash.truncated, true);
});

test("parseToolResultData ignores non-JSON results", () => {
  assert.equal(parseToolResultData("Edit", "Error: File has not been read yet."), null);
  assert.equal(parseToolResultData("Bash", "plain text output"), null);
});

test("extractJsonStringField decodes escapes and stops at closing quote", () => {
  const text = '{"content": "a\\nb\\"c", "next": 1}';
  assert.equal(extractJsonStringField(text, "content"), 'a\nb"c');
  assert.equal(extractJsonStringField(text, "missing"), null);
});
