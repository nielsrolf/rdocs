import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { buildUserPrompt } from "../lib/ai";
import { buildConversationHistory } from "../lib/ai-runs";
import { db } from "../lib/db";

// Graceful session continuation: a follow-up message into a failed/cancelled
// edit session starts a new SELECTION_EDIT run that (a) threads under the same
// session via parentRunId and (b) hands the agent the prior attempts'
// transcript so it continues instead of restarting.

const editInput = {
  mode: "edit_selection" as const,
  documentTitle: "Doc",
  documentText: "Some text",
  documentBlocks: [{ type: "text" as const, text: "Some text" }],
  unresolvedThreads: [],
  workspacePath: "/tmp/repo",
  workspaceOverview: "",
  selectedText: "Results",
  selectedMarkdown: null,
  selectedContext: null,
  instruction: "continue the experiment run"
};

test("edit_selection prompt embeds the previous session transcript for continuations", () => {
  const prompt = buildUserPrompt({
    ...editInput,
    conversationHistory: [
      { role: "user", message: "run the experiments and report results" },
      { role: "agent", message: "I started the sweep; 3 of 4 models are done." }
    ]
  });

  assert.ok(prompt.includes("<previous_session>"), "continuation block present");
  assert.ok(prompt.includes("run the experiments and report results"));
  assert.ok(prompt.includes("3 of 4 models are done"));
  assert.ok(
    prompt.includes("already present in your worktree"),
    "prompt tells the agent prior committed work is in its worktree"
  );
});

test("a fresh edit prompt has no continuation block", () => {
  const prompt = buildUserPrompt(editInput);
  assert.equal(prompt.includes("<previous_session>"), false);
});

test("buildConversationHistory flattens the session chain into user/agent turns", async () => {
  const user = await db.user.create({
    data: { email: `cont-${crypto.randomUUID()}@example.com`, name: "cont", passwordHash: "x" }
  });
  const document = await db.document.create({
    data: { title: "Continuation test", content: "{}", ownerId: user.id }
  });
  try {
    const root = await db.aiRun.create({
      data: {
        documentId: document.id,
        triggerType: "SELECTION_EDIT",
        instruction: "original edit request",
        status: "FAILED"
      }
    });
    for (const [role, message] of [
      ["user", "original edit request"],
      ["tool", "Bash: {\"command\":\"ls\"}"],
      ["agent", "started the work, got interrupted"]
    ] as const) {
      await db.aiRunEvent.create({ data: { aiRunId: root.id, role, message } });
    }
    const followUp = await db.aiRun.create({
      data: {
        documentId: document.id,
        triggerType: "SELECTION_EDIT",
        parentRunId: root.id,
        instruction: "please continue",
        status: "FAILED"
      }
    });
    await db.aiRunEvent.create({ data: { aiRunId: followUp.id, role: "user", message: "please continue" } });

    const { history, rootRunId } = await buildConversationHistory(document.id, followUp.id);

    assert.equal(rootRunId, root.id, "chain resolves to the session root");
    assert.deepEqual(
      history.map((turn) => turn.role),
      ["user", "agent", "user"],
      "only user/agent events survive, in order (tool noise dropped)"
    );
    assert.equal(history[0].message, "original edit request");
    assert.equal(history[1].message, "started the work, got interrupted");
    assert.equal(history[2].message, "please continue");

    // A parent from another document must not leak its session.
    const foreign = await buildConversationHistory(`not-${document.id}`, followUp.id);
    assert.deepEqual(foreign.history, []);
  } finally {
    await db.document.delete({ where: { id: document.id } }).catch(() => null);
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
  }
});
