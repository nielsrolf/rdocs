// A superseded session reader is a HANDOVER, not a failure.
//
// 2026-08-11 incident: another process attached to a detached session container
// this process was driving. The frames poll threw AttachSupersededError, the
// generic lifecycle catch marked the run FAILED, Slack posted "The run failed:
// Another process attached to this agent session container.", and the credential
// broker then killed the agent that was still happily working in the container.
//
// Whoever attached is now the reader and owns the terminal bookkeeping, so the
// superseded process must step aside quietly: no FAILED write, no error event,
// no failure outcome for Slack.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { withAgentRunLifecycle } from "../lib/agent-run-lifecycle";
import { AttachSupersededError } from "../lib/agent-runner/session-client";
import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";

async function fixture() {
  const user = await db.user.create({
    data: {
      email: `handover-${crypto.randomUUID()}@example.com`,
      name: "handover",
      passwordHash: "x"
    }
  });
  const document = await db.document.create({
    data: {
      title: "Handover test",
      content: serializeDocumentContent({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "handover" }] }]
      }),
      ownerId: user.id
    }
  });
  const run = await db.aiRun.create({
    data: {
      documentId: document.id,
      createdById: user.id,
      triggerType: "SLACK_MENTION",
      instruction: "keep working in the container",
      status: "RUNNING",
      startedAt: new Date(),
      heartbeatAt: new Date()
    }
  });
  return { user, document, run };
}

async function cleanup(documentId: string, userId: string) {
  await db.aiRun.updateMany({ where: { documentId }, data: { status: "FAILED" } });
  await db.document.delete({ where: { id: documentId } }).catch(() => null);
  await db.user.delete({ where: { id: userId } }).catch(() => null);
}

test("a superseded session reader hands the run over instead of failing it", async () => {
  const { user, document, run } = await fixture();
  try {
    const result = await withAgentRunLifecycle(
      {
        aiRunId: run.id,
        documentId: document.id,
        createdById: user.id,
        agentAccessMode: "workspace",
        runnerMode: "managed",
        failureCommitMessage: "wip",
        defaultFailureMessage: "run failed"
      },
      async () => {
        throw new AttachSupersededError();
      }
    );

    assert.equal(result.status, "HANDED_OFF");

    const fresh = await db.aiRun.findUnique({
      where: { id: run.id },
      select: { status: true, error: true, finishedAt: true }
    });
    assert.equal(fresh?.status, "RUNNING", "the adopting process owns the terminal state now");
    assert.equal(fresh?.error, null);
    assert.equal(fresh?.finishedAt, null);

    const events = await db.aiRunEvent.findMany({
      where: { aiRunId: run.id },
      select: { role: true, message: true }
    });
    assert.deepEqual(
      events.filter((event) => event.role === "error"),
      [],
      "a handover is not an error"
    );
    assert.ok(
      events.some((event) => event.role === "system" && /another server process/i.test(event.message)),
      JSON.stringify(events)
    );
  } finally {
    await cleanup(document.id, user.id);
  }
});
