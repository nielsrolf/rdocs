import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { upsertAgentApiChannel, revokeAgentApiChannel } from "../lib/agent-api-channels";
import {
  cancelChannelSchedule,
  ChannelScheduleError,
  createChannelSchedule,
  fireApiChannelTask,
  listChannelSchedules
} from "../lib/agent-channel-schedules";
import { db } from "../lib/db";
import { fireScheduledTask } from "../lib/scheduler";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

async function fixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { email: `sched-${suffix}@example.com`, name: "Sched", passwordHash: "x" }
  });
  const document = await db.document.create({
    data: { title: `sched ${suffix}`, content: "{}", ownerId: user.id }
  });
  await upsertAgentApiChannel({ documentId: document.id, createdById: user.id, label: "test" });
  return { user, document };
}

test("api_channel schedules: create, list, fire as a channel run, cancel", async (t) => {
  const { user, document } = await fixture();
  t.after(async () => {
    await db.document.delete({ where: { id: document.id } }).catch(() => null);
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
  });

  await assert.rejects(
    createChannelSchedule({ documentId: document.id, createdById: user.id, instruction: "x", cron: "* * * * *" }),
    ChannelScheduleError
  );
  await assert.rejects(
    createChannelSchedule({ documentId: document.id, createdById: user.id, instruction: "x" }),
    ChannelScheduleError
  );
  const schedule = await createChannelSchedule({
    documentId: document.id,
    createdById: user.id,
    instruction: "Refresh your forecasts.",
    cron: "30 7 * * *",
    timezone: "Europe/Berlin"
  });
  assert.equal(schedule.cron, "30 7 * * *");
  assert.deepEqual((await listChannelSchedules(document.id)).map((s) => s.id), [schedule.id]);

  const started: string[] = [];
  const task = await db.scheduledTask.findUniqueOrThrow({ where: { id: schedule.id } });
  const runId = await fireScheduledTask(task, undefined, {
    startRun: async ({ channel, message }) => {
      assert.equal(channel.documentId, document.id);
      assert.match(message, /Refresh your forecasts/);
      started.push(message);
      return "run-1";
    }
  });
  assert.equal(runId, "run-1");
  assert.equal(started.length, 1);
  assert.equal((await listChannelSchedules(document.id))[0].lastRunId, "run-1");

  // foreign document ids cannot cancel it; the owning channel can
  assert.equal(await cancelChannelSchedule("other-doc", schedule.id), false);
  assert.equal(await cancelChannelSchedule(document.id, schedule.id), true);
  assert.deepEqual(await listChannelSchedules(document.id), []);

  // a revoked channel kills its standing jobs on the next firing
  const again = await createChannelSchedule({
    documentId: document.id, createdById: user.id, instruction: "again", cron: "0 8 * * *"
  });
  await revokeAgentApiChannel(document.id, user.id);
  const fired = await fireApiChannelTask(await db.scheduledTask.findUniqueOrThrow({ where: { id: again.id } }), {
    startRun: async () => { throw new Error("must not start"); }
  });
  assert.equal(fired, null);
  assert.deepEqual(await listChannelSchedules(document.id), []);
});
