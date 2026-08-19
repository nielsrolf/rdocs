import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  containerNameForRun,
  listRunContainerIds,
  reconcileRunContainers,
  removeRunContainers
} from "../lib/agent-runner/container-cleanup";
import { failAbandonedAiRuns, STALE_AI_RUN_MS } from "../lib/ai-runs";
import { db } from "../lib/db";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

type Call = { cmd: string; args: string[] };

function fakeExec(responses: Array<{ code: number; stdout?: string }>) {
  const calls: Call[] = [];
  return {
    calls,
    exec: async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const next = responses.shift() ?? { code: 0, stdout: "" };
      return { code: next.code, stdout: next.stdout ?? "" };
    }
  };
}

async function makeRun(status: string, startedAt: Date, heartbeatAt: Date | null) {
  const user = await db.user.create({
    data: { email: `ghost-${crypto.randomUUID()}@example.com`, name: "ghost", passwordHash: "x" }
  });
  const doc = await db.document.create({ data: { ownerId: user.id, title: "ghosts", content: "{}" } });
  return db.aiRun.create({
    data: {
      documentId: doc.id,
      triggerType: "CONVERSATION",
      instruction: "x",
      status,
      startedAt,
      heartbeatAt
    }
  });
}

test("removeRunContainers force-removes the runs' named containers", async () => {
  const { calls, exec } = fakeExec([{ code: 0 }]);
  await removeRunContainers(["run-a", "run-b"], { runtime: "docker", exec });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["rm", "-f", "gdocs-run-run-a", "gdocs-run-run-b"]);
});

test("removeRunContainers is a no-op without run ids", async () => {
  const { calls, exec } = fakeExec([]);
  await removeRunContainers([], { exec });
  assert.equal(calls.length, 0);
});

test("listRunContainerIds parses names and reports runtime unavailability as null", async () => {
  const listing = fakeExec([{ code: 0, stdout: "gdocs-run-aaa\ngdocs-run-bbb\nnoise\n" }]);
  assert.deepEqual(await listRunContainerIds({ exec: listing.exec }), ["aaa", "bbb"]);

  const broken = fakeExec([{ code: -1 }]);
  assert.equal(await listRunContainerIds({ exec: broken.exec }), null);
});

test("reconcileRunContainers removes containers of terminal/unknown runs, spares live ones", async () => {
  const now = new Date();
  const running = await makeRun("RUNNING", now, now);
  const failed = await makeRun("FAILED", now, null);
  const unknownId = `missing-${crypto.randomUUID()}`;
  const stdout = [running.id, failed.id, unknownId].map(containerNameForRun).join("\n");
  const { calls, exec } = fakeExec([{ code: 0, stdout }, { code: 0 }]);

  const { removed } = await reconcileRunContainers({ exec });

  assert.deepEqual(new Set(removed), new Set([failed.id, unknownId]));
  const rmCall = calls.find((c) => c.args[0] === "rm");
  assert.ok(rmCall, "expected a docker rm invocation");
  assert.ok(!rmCall!.args.includes(containerNameForRun(running.id)), "must not remove a live run's container");
});

test("failAbandonedAiRuns kills the reaped runs' containers", async () => {
  const stale = new Date(Date.now() - STALE_AI_RUN_MS - 60_000);
  const run = await makeRun("RUNNING", stale, stale);
  const { calls, exec } = fakeExec([{ code: 0 }]);

  const result = await failAbandonedAiRuns([{ id: run.id, status: run.status, startedAt: run.startedAt }], Date.now(), {
    containerCleanup: { exec }
  });

  assert.ok(result, "run should be reaped");
  assert.ok(result!.failedIds.has(run.id));
  const after = await db.aiRun.findUnique({ where: { id: run.id }, select: { status: true } });
  assert.equal(after!.status, "FAILED");
  const rmCall = calls.find((c) => c.args[0] === "rm");
  assert.ok(rmCall, "reaping must remove the run's container");
  assert.ok(rmCall!.args.includes(containerNameForRun(run.id)));
});
