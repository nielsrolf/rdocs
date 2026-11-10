import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AiRunEventView } from "../components/document-workspace/types";
import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";
import {
  annotateDigest,
  buildOutlineDigest,
  getRunOutline,
  OUTLINE_CHUNK_ITEMS,
  parseOutlineResponse,
  runOutlineJob,
  type OutlineModel
} from "../lib/run-outline";

// The agent view's outline is a few model-written section titles over the
// timeline. These tests cover the digest the model reads, the tolerance of the
// reply parser, chunked + incremental annotation, and the route-level flow
// against a fake OpenAI-compatible endpoint.

let seq = 0;
function ev(role: string, message: string): AiRunEventView {
  seq += 1;
  return { id: `e${seq}`, role, message, createdAt: new Date(1_700_000_000_000 + seq * 1000).toISOString() } as AiRunEventView;
}

const MODEL: OutlineModel = { api: "openai", baseUrl: "http://unused", apiKey: null, model: "fake", label: "test:fake" };

test("the digest has one line per message and tool call, flags failures, drops plumbing", () => {
  const digest = buildOutlineDigest([
    ev("user", "Run the eval\nwith all conditions"),
    ev("system", "Using isolated worktree /x"),
    ev("tool", 'Bash: {"command":"pip install openai"}'),
    ev("tool_result", "Error: Exit code 1"),
    ev("tool", 'TodoWrite: {"todos":[]}'),
    ev("tool_result", "ok"),
    ev("tool", 'Write: {"file_path":"/workspace/run_eval.py","content":"x"}'),
    ev("tool_result", "ok"),
    ev("agent", "Eval is running.")
  ]);
  assert.deepEqual(
    digest.map((item) => item.line),
    [
      "USER: Run the eval with all conditions",
      "Bash: pip install openai [FAILED]",
      "Write: /workspace/run_eval.py",
      "AGENT: Eval is running."
    ]
  );
});

test("the reply parser tolerates fences and drops bad sections", () => {
  const reply = 'Here you go:\n```json\n{"sections":[{"start":3,"title":"Set up the environment."},{"start":2,"title":"Backwards"},{"start":9,"title":"Write the eval script"},{"start":99,"title":"Out of range"},{"start":12,"title":""}]}\n```';
  assert.deepEqual(parseOutlineResponse(reply, 0, 20), [
    // The first section is pulled to the start of the excerpt.
    { index: 0, title: "Set up the environment" },
    { index: 8, title: "Write the eval script" }
  ]);
  assert.deepEqual(parseOutlineResponse("no json here", 0, 20), []);
});

function digestOf(count: number) {
  return Array.from({ length: count }, (_, index) => ({ eventId: `i${index}`, line: `Bash: step ${index}` }));
}

test("a long log is annotated in chunks, redoing the section cut by the chunk boundary", async () => {
  const items = digestOf(OUTLINE_CHUNK_ITEMS + 80);
  const ranges: Array<[number, number]> = [];
  const result = await annotateDigest(items, [], [MODEL], async (_model, prompt) => {
    const match = /Events (\d+) to (\d+):/.exec(prompt.user)!;
    const from = Number(match[1]);
    const to = Number(match[2]);
    ranges.push([from, to]);
    // Two sections per excerpt: one at its start, one 100 events in.
    return JSON.stringify({ sections: [{ start: from, title: `Phase at ${from}` }, { start: from + 100, title: `Phase at ${from + 100}` }] });
  });
  // Second call starts at the last section of the first chunk (event 101), not at the chunk end.
  assert.deepEqual(ranges, [[1, OUTLINE_CHUNK_ITEMS], [101, OUTLINE_CHUNK_ITEMS + 80]]);
  assert.deepEqual(
    result.sections.map((section) => [section.startEventId, section.title]),
    [["i0", "Phase at 1"], ["i100", "Phase at 101"], ["i200", "Phase at 201"]]
  );
  assert.equal(result.covered, items.length);
  assert.equal(result.calls, 2);
});

test("a grown log keeps its earlier sections and only re-reads from the last one", async () => {
  const items = digestOf(60);
  const previous = [
    { startEventId: "i0", title: "Set up" },
    { startEventId: "i20", title: "Write the script" },
    { startEventId: "i35", title: "First run" }
  ];
  let asked = "";
  const result = await annotateDigest(items, previous, [MODEL], async (_model, prompt) => {
    asked = prompt.user;
    return JSON.stringify({ sections: [{ start: 36, title: "First run and its crash" }, { start: 50, title: "Fix the crash" }] });
  });
  assert.match(asked, /Events 36 to 60:/);
  assert.match(asked, /- Write the script/);
  assert.deepEqual(result.sections.map((section) => section.title), ["Set up", "Write the script", "First run and its crash", "Fix the crash"]);
});

test("a failing model falls through to the next one; none working is an error", async () => {
  const bad: OutlineModel = { ...MODEL, label: "test:bad" };
  const result = await annotateDigest(digestOf(12), [], [bad, MODEL], async (model) => {
    if (model.label === "test:bad") throw new Error("401");
    return '{"sections":[{"start":1,"title":"Everything"}]}';
  });
  assert.equal(result.model, "test:fake");
  await assert.rejects(annotateDigest(digestOf(12), [], [bad], async () => { throw new Error("401"); }));
});

async function makeRun(status: string, toolCalls: number) {
  const user = await db.user.create({
    data: { email: `run-outline-${crypto.randomUUID()}@example.com`, name: "run outline", passwordHash: "x" }
  });
  const document = await db.document.create({
    data: {
      title: "Run outline test",
      content: serializeDocumentContent({ type: "doc", content: [{ type: "paragraph" }] }),
      ownerId: user.id
    }
  });
  const run = await db.aiRun.create({
    data: { documentId: document.id, triggerType: "CONVERSATION", instruction: "Run the eval", status }
  });
  const base = Date.now() - 3_600_000;
  const rows = [{ role: "user", message: "Run the eval" }];
  for (let i = 0; i < toolCalls; i++) {
    rows.push({ role: "tool", message: `Bash: ${JSON.stringify({ command: `step ${i}` })}` });
    rows.push({ role: "tool_result", message: '{"stdout":"ok","stderr":""}' });
  }
  rows.push({ role: "system", message: `[usage] ${JSON.stringify({ model: "m", costUsd: 0.01 })}` });
  rows.push({ role: "agent", message: "Done." });
  await db.aiRunEvent.createMany({
    data: rows.map((row, index) => ({ ...row, aiRunId: run.id, createdAt: new Date(base + index * 1000) }))
  });
  return { user, document, run };
}

test("opening a finished run generates its outline once, in the background", async () => {
  let calls = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      calls += 1;
      const payload = JSON.parse(body) as { messages: Array<{ content: string }> };
      assert.doesNotMatch(payload.messages[1].content, /\[usage\]/);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [{ message: { content: '{"sections":[{"start":1,"title":"Kick off the eval"},{"start":8,"title":"Run the remaining steps"}]}' } }]
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previousBase = process.env.LOCAL_MODEL_BASE_URL;
  const previousName = process.env.LOCAL_MODEL_NAME;
  process.env.LOCAL_MODEL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.LOCAL_MODEL_NAME = "fake-local";
  try {
    const { user, document, run } = await makeRun("SUCCEEDED", 14);
    const request = { runId: run.id, documentId: document.id, userId: user.id };

    // A viewer without agent access never triggers a model call.
    assert.equal((await getRunOutline({ ...request, canGenerate: false }))?.status, "unavailable");
    assert.equal(calls, 0);

    assert.equal((await getRunOutline({ ...request, canGenerate: true }))?.status, "pending");
    await runOutlineJob(run.id);
    const outline = await getRunOutline({ ...request, canGenerate: true });
    assert.equal(outline?.status, "ready");
    assert.equal(outline?.model, "local:fake-local");
    assert.deepEqual(outline?.sections.map((section) => section.title), ["Kick off the eval", "Run the remaining steps"]);
    const events = await db.aiRunEvent.findMany({ where: { aiRunId: run.id }, orderBy: { createdAt: "asc" }, select: { id: true, role: true } });
    assert.equal(outline?.sections[0].startEventId, events[0].id);
    // Final: later reads are served from the row, including for plain viewers.
    assert.equal((await getRunOutline({ ...request, canGenerate: false }))?.status, "ready");
    assert.equal(calls, 1);

    // A run too short to need sections never reaches the model.
    const short = await makeRun("SUCCEEDED", 2);
    await getRunOutline({ runId: short.run.id, documentId: short.document.id, userId: short.user.id, canGenerate: true });
    await runOutlineJob(short.run.id);
    assert.deepEqual(
      (await getRunOutline({ runId: short.run.id, documentId: short.document.id, userId: short.user.id, canGenerate: true }))?.sections,
      []
    );
    assert.equal(calls, 1);
  } finally {
    if (previousBase === undefined) delete process.env.LOCAL_MODEL_BASE_URL;
    else process.env.LOCAL_MODEL_BASE_URL = previousBase;
    if (previousName === undefined) delete process.env.LOCAL_MODEL_NAME;
    else process.env.LOCAL_MODEL_NAME = previousName;
    server.close();
    await db.$disconnect();
  }
});
