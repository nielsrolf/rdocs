import assert from "node:assert/strict";
import test from "node:test";

import {
  agentDisplayName,
  extractJsonStringField,
  extractToolDiff,
  findFinalReplyIndex,
  formatToolResult,
  groupAgentEvents,
  lifecycleStepLabel,
  parseToolMessage,
  parseToolResultData,
  slackMessageField,
  toolDisplayName
} from "../components/document-workspace/agent-timeline";
import { mergeRunEventTimelines } from "../components/document-workspace/conversations";
import type { AiRunEventView } from "../components/document-workspace/types";
import {
  PREPARING_DOCUMENT_UPDATE,
  RUN_RETRYING,
  RUN_STARTED_CLAUDE,
  RUN_STARTED_CODEX,
  RUN_STARTED_LOCAL_FALLBACK,
  RUN_STARTED_SLACK,
  SUBMIT_STEP_LABEL,
  SUBMITTING_FINAL_RESPONSE
} from "../agent-core/lifecycle-messages";

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

test("agentDisplayName reflects the run harness", () => {
  assert.equal(agentDisplayName("codex-sdk:litellm/openai/gpt-5.6-sol+medium"), "Codex");
  assert.equal(agentDisplayName("claude-agent-sdk:claude-opus-5"), "Claude");
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

test("every emitted lifecycle message is recognised by the step matcher", () => {
  // Guards the producer/consumer contract: agent-core emits these strings and
  // the agent panel must render each as a quiet step row. Adding a producer
  // constant without teaching lifecycleStepLabel about it fails here.
  for (const message of [
    RUN_STARTED_CLAUDE,
    RUN_STARTED_CODEX,
    RUN_STARTED_LOCAL_FALLBACK,
    RUN_STARTED_SLACK,
    RUN_RETRYING,
    SUBMITTING_FINAL_RESPONSE,
    PREPARING_DOCUMENT_UPDATE
  ]) {
    assert.ok(lifecycleStepLabel(message), `no step label for ${message}`);
  }
  assert.equal(lifecycleStepLabel(SUBMITTING_FINAL_RESPONSE), SUBMIT_STEP_LABEL);
});

test("lifecycle plumbing becomes step rows, not prose", () => {
  assert.equal(lifecycleStepLabel("Starting Claude research agent."), "Run started");
  assert.equal(lifecycleStepLabel("Starting Codex research agent."), "Run started");
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

test("parseToolResultData renders image Reads as image data, never raw base64 JSON", () => {
  // Small image: payload fits the event cap intact → inline-renderable.
  const complete = JSON.stringify({ type: "image", file: { base64: "aGVsbG8=" } });
  assert.deepEqual(parseToolResultData("Read", complete), {
    kind: "image",
    base64: "aGVsbG8=",
    truncated: false
  });

  // Screenshot: base64 overflows the 1400-char cap → clipped mid-string. The
  // partial base64 is unusable, so it must come back null (placeholder row).
  const big = JSON.stringify({ type: "image", file: { base64: "i".repeat(3000) } });
  const clipped = big.slice(0, 1400);
  const data = parseToolResultData("Read", clipped);
  assert.ok(data && data.kind === "image");
  assert.equal(data.base64, null);
  assert.equal(data.truncated, true);
});

test("parseToolResultData reads TaskOutput task payloads", () => {
  const message = JSON.stringify({
    retrieval_status: "success",
    task: {
      task_id: "abc123",
      task_type: "local_bash",
      status: "completed",
      description: "Blue/green deploy",
      output: "[deploy] done.\n",
      exitCode: 0
    }
  });
  assert.deepEqual(parseToolResultData("TaskOutput", message), {
    kind: "taskOutput",
    status: "completed",
    description: "Blue/green deploy",
    output: "[deploy] done.\n",
    exitCode: 0,
    retrievalStatus: "success",
    truncated: false
  });

  // Clipped mid-output: status/description serialize before output, so they
  // survive; the output prefix is still shown.
  const big = JSON.stringify({
    retrieval_status: "success",
    task: { task_id: "x", status: "completed", description: "long job", output: "line\n".repeat(600) }
  });
  const clippedData = parseToolResultData("TaskOutput", big.slice(0, 300));
  assert.ok(clippedData && clippedData.kind === "taskOutput");
  assert.equal(clippedData.status, "completed");
  assert.equal(clippedData.description, "long job");
  assert.ok(clippedData.output.startsWith("line\n"));
  assert.equal(clippedData.truncated, true);
});

test("slackMessageField identifies message-payload MCP tools", () => {
  assert.equal(slackMessageField("mcp__gdocs__post_slack_message"), "text");
  assert.equal(slackMessageField("mcp__gdocs__read_slack_channel"), null);
  assert.equal(slackMessageField("Bash"), null);
});

test("parseToolResultData ignores non-JSON results", () => {
  assert.equal(parseToolResultData("Edit", "Error: File has not been read yet."), null);
  assert.equal(parseToolResultData("Bash", "plain text output"), null);
});

// --- content-block ("array") tool results, as emitted for subagent tool calls ---

function contentBlockResult(text: string): string {
  return JSON.stringify([{ tool_use_id: "toolu_abc", type: "tool_result", content: text }], null, 2);
}

test("parseToolResultData reads Read results delivered as content blocks", () => {
  const data = parseToolResultData(
    "Read",
    contentBlockResult("265\t// run) and become ONE follow-up run\n266\tconst x = 1;")
  );
  assert.equal(data?.kind, "file");
  assert.equal(data && data.kind === "file" ? data.startLine : null, 265);
  assert.equal(
    data && data.kind === "file" ? data.content : null,
    "// run) and become ONE follow-up run\nconst x = 1;"
  );
});

test("parseToolResultData reads Bash and Grep content-block results", () => {
  const bash = parseToolResultData("Bash", contentBlockResult("ok\ndone"));
  assert.deepEqual(bash, { kind: "bash", stdout: "ok\ndone", stderr: "", truncated: false });
  const grep = parseToolResultData("Grep", contentBlockResult("a.ts:1:hit\nb.ts:2:hit"));
  assert.equal(grep?.kind, "grep");
});

test("formatToolResult unwraps content blocks instead of dumping JSON", () => {
  assert.equal(formatToolResult(contentBlockResult("Task #1 created successfully: Do it")), "Task #1 created successfully: Do it");
  assert.equal(
    formatToolResult(JSON.stringify([{ type: "text", text: "legacy text block" }])),
    "legacy text block"
  );
});

// --- clipped-run timeline merging (long sessions must not lose their start) ---

test("mergeRunEventTimelines unions archived beginning with polled tail", () => {
  const at = (i: number) => new Date(1700000000000 + i * 1000).toISOString();
  const mk = (i: number): AiRunEventView => ({
    id: `e${String(i).padStart(3, "0")}`,
    role: "tool",
    message: `event ${i}`,
    createdAt: at(i)
  });
  // Archived fetch captured events 0..9; the poll window has 6..12 (overlap + new tail).
  const archived = Array.from({ length: 10 }, (_, i) => mk(i));
  const polled = Array.from({ length: 7 }, (_, i) => mk(i + 6));
  const merged = mergeRunEventTimelines(archived, polled);
  assert.equal(merged.length, 13, "overlap deduped by id");
  assert.equal(merged[0].message, "event 0", "the beginning survives");
  assert.equal(merged[merged.length - 1].message, "event 12", "the live tail survives");
  for (let i = 1; i < merged.length; i++) {
    assert.ok(
      new Date(merged[i - 1].createdAt).getTime() <= new Date(merged[i].createdAt).getTime(),
      "chronological order"
    );
  }
});

test("mergeRunEventTimelines breaks createdAt ties by id", () => {
  const t = new Date(1700000000000).toISOString();
  const a: AiRunEventView = { id: "a", role: "tool", message: "first", createdAt: t };
  const b: AiRunEventView = { id: "b", role: "tool", message: "second", createdAt: t };
  assert.deepEqual(
    mergeRunEventTimelines([b], [a]).map((e) => e.id),
    ["a", "b"]
  );
});

test("extractJsonStringField decodes escapes and stops at closing quote", () => {
  const text = '{"content": "a\\nb\\"c", "next": 1}';
  assert.equal(extractJsonStringField(text, "content"), 'a\nb"c');
  assert.equal(extractJsonStringField(text, "missing"), null);
});
