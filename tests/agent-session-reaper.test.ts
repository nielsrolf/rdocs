// The reaper must not kill a detached session container that is still working.
//
// Before detached containers, silence meant death: the owning process was the
// container's parent, so no heartbeat implied nobody was consuming the result.
// A detached container is nobody's child — it keeps running across a deploy and
// is adopted by whichever process attaches next. So a run that still advertises
// a session endpoint which ANSWERS must be spared, and its container must not be
// `docker rm -f`'d.
//
// The probe is injected; the DB is real (as in ai-run-reaper.test.ts).

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { failAbandonedAiRuns, STALE_AI_RUN_MS } from "../lib/ai-runs";
import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";

function content() {
  return serializeDocumentContent({ type: "doc", content: [{ type: "paragraph" }] });
}

async function makeDoc(label: string) {
  const user = await db.user.create({
    data: { email: `session-reaper-${label}-${crypto.randomUUID()}@example.com`, name: label, passwordHash: "x" }
  });
  const document = await db.document.create({
    data: { title: "Session reaper test", content: content(), ownerId: user.id }
  });
  return { user, document };
}

async function makeDetachedRun(documentId: string, now: number, advertise: boolean) {
  return db.aiRun.create({
    data: {
      documentId,
      triggerType: "SELECTION_EDIT",
      instruction: "detached run",
      status: "RUNNING",
      startedAt: new Date(now - STALE_AI_RUN_MS - 60_000),
      heartbeatAt: new Date(now - STALE_AI_RUN_MS - 30_000),
      containerId: "abcdef012345",
      sessionEndpoint: advertise ? "http://127.0.0.1:53535" : null,
      sessionSecret: advertise ? "container-secret" : null
    }
  });
}

async function cleanup(documentId: string, userId: string) {
  await db.document.delete({ where: { id: documentId } }).catch(() => null);
  await db.user.delete({ where: { id: userId } }).catch(() => null);
}

test("a silent run whose detached container still answers is spared, container intact", async () => {
  const { user, document } = await makeDoc("alive");
  const now = Date.now();
  const removed: string[][] = [];
  const probed: Array<{ endpoint: string | null; secret: string | null }> = [];
  try {
    const run = await makeDetachedRun(document.id, now, true);

    const reaped = await failAbandonedAiRuns([run], now, {
      containerCleanup: { exec: async (_file: string, args: string[]) => {
          removed.push(args);
          return { stdout: "", stderr: "", code: 0 };
        } },
      sessionProbe: async (candidate) => {
        probed.push({ endpoint: candidate.sessionEndpoint, secret: candidate.sessionSecret });
        return true;
      }
    });

    assert.equal(reaped?.failedIds.has(run.id) ?? false, false, "a live detached session must not be reaped");
    assert.deepEqual(probed, [{ endpoint: "http://127.0.0.1:53535", secret: "container-secret" }]);
    assert.deepEqual(removed, [], "a live container must never be force-removed");

    const fresh = await db.aiRun.findUnique({
      where: { id: run.id },
      select: { status: true, heartbeatAt: true }
    });
    assert.equal(fresh?.status, "RUNNING");
    // The heartbeat stays stale ON PURPOSE: sparing must be re-earned on every
    // sweep by the container answering again. Faking a heartbeat here would make
    // an orphan that nobody ever adopts immortal.
    assert.ok((fresh?.heartbeatAt?.getTime() ?? 0) < now - STALE_AI_RUN_MS, "sparing must not fake a heartbeat");
  } finally {
    await cleanup(document.id, user.id);
  }
});

test("a silent run whose detached container is gone is reaped as before", async () => {
  const { user, document } = await makeDoc("dead");
  const now = Date.now();
  try {
    const run = await makeDetachedRun(document.id, now, true);

    const reaped = await failAbandonedAiRuns([run], now, {
      containerCleanup: { exec: async () => ({ stdout: "", stderr: "", code: 0 }) },
      sessionProbe: async () => false
    });

    assert.equal(reaped?.failedIds.has(run.id), true, "an unreachable container is a dead run");
    const fresh = await db.aiRun.findUnique({ where: { id: run.id }, select: { status: true } });
    assert.equal(fresh?.status, "FAILED");
  } finally {
    await cleanup(document.id, user.id);
  }
});

test("a run that advertises no session endpoint is never probed", async () => {
  const { user, document } = await makeDoc("piped");
  const now = Date.now();
  let probes = 0;
  try {
    const run = await makeDetachedRun(document.id, now, false);

    const reaped = await failAbandonedAiRuns([run], now, {
      containerCleanup: { exec: async () => ({ stdout: "", stderr: "", code: 0 }) },
      sessionProbe: async () => {
        probes += 1;
        return true;
      }
    });

    assert.equal(probes, 0, "legacy piped runs have no session to probe");
    assert.equal(reaped?.failedIds.has(run.id), true);
  } finally {
    await cleanup(document.id, user.id);
  }
});
