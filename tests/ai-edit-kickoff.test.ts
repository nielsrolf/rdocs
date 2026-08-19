import assert from "node:assert/strict";
import test from "node:test";

import { startAiEditRun } from "../components/document-workspace/ai-edit-kickoff";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("a 202 with an aiRunId is a successful kickoff", async () => {
  let seen: { url: string; body: unknown } | null = null;
  const result = await startAiEditRun(
    "doc1",
    { selectedText: "hello", instruction: "shorten", selectionId: "sel1" },
    {
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, body: JSON.parse(String(init.body)) };
        return jsonResponse({ aiRunId: "run1", status: "PENDING" }, 202);
      }) as unknown as typeof fetch
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.aiRunId, "run1");
  assert.equal(seen!.url, "/api/documents/doc1/ai-edit");
  assert.deepEqual(seen!.body, {
    selectedText: "hello",
    instruction: "shorten",
    selectionId: "sel1"
  });
});

test("a server error message is surfaced verbatim, not the generic fallback", async () => {
  const result = await startAiEditRun(
    "doc1",
    { selectedText: "hello", instruction: "shorten" },
    {
      fallbackError: "Agent follow-up failed to start.",
      fetchImpl: (async () =>
        jsonResponse({ error: "You do not have edit access." }, 403)) as unknown as typeof fetch
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error, "You do not have edit access.");
  assert.equal(result.ok === false && result.serverError, "You do not have edit access.");
  assert.equal(result.ok === false && result.status, 403);
  assert.equal(result.ok === false && result.threw, false);
});

test("a 200 without an aiRunId is a failure, not a silent success", async () => {
  const result = await startAiEditRun(
    "doc1",
    { selectedText: "hello", instruction: "shorten" },
    { fetchImpl: (async () => jsonResponse({}, 200)) as unknown as typeof fetch }
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error, "AI edit failed to start.");
  assert.equal(result.ok === false && result.serverError, null);
});

test("a thrown fetch reports threw=true with a null status and notifies the caller", async () => {
  let logged: unknown = null;
  const result = await startAiEditRun(
    "doc1",
    { selectedText: "hello", instruction: "shorten" },
    {
      onFetchError: (error) => {
        logged = error;
      },
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.threw, true);
  assert.equal(result.ok === false && result.status, null);
  assert.equal((logged as Error).message, "network down");
});
