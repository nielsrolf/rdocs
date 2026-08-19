import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { db } from "../lib/db";
import { pruneVersionHistory } from "../lib/document-data";

// Retention regression coverage for the 39GB dev.db incident: version
// snapshots store full document content, so history must stay bounded.
// Policy: keep everything from the last 24h, thin older snapshots to the
// newest one per UTC day, hard-cap the total per document.

const DAY_MS = 24 * 60 * 60 * 1000;

async function makeDocWithVersions(versionAges: number[], now: number) {
  const user = await db.user.create({
    data: { email: `retention-${crypto.randomUUID()}@example.com`, name: "retention", passwordHash: "x" }
  });
  const doc = await db.document.create({
    data: { title: "retention test", content: JSON.stringify({ type: "doc", content: [] }), ownerId: user.id }
  });
  for (const [index, ageMs] of versionAges.entries()) {
    await db.documentVersion.create({
      data: {
        documentId: doc.id,
        title: `v${index}`,
        content: `content ${index}`,
        createdAt: new Date(now - ageMs)
      }
    });
  }
  return { doc, user };
}

async function cleanup(userId: string) {
  await db.user.delete({ where: { id: userId } });
}

test("keeps all snapshots from the last 24h", async () => {
  const now = Date.now();
  const { doc, user } = await makeDocWithVersions(
    [0, 60_000, 3_600_000, 12 * 3_600_000, 23 * 3_600_000],
    now
  );
  try {
    const deleted = await pruneVersionHistory(doc.id, now);
    assert.equal(deleted, 0);
    assert.equal(await db.documentVersion.count({ where: { documentId: doc.id } }), 5);
  } finally {
    await cleanup(user.id);
  }
});

test("thins snapshots older than 24h to the newest per UTC day", async () => {
  // Anchor to midday UTC so hour offsets never cross a day boundary.
  const now = new Date("2026-08-01T12:00:00Z").getTime();
  const { doc, user } = await makeDocWithVersions(
    [
      60_000, // recent, kept
      DAY_MS + 1 * 3_600_000, // 2026-07-31 11:00, newest of its day -> kept
      DAY_MS + 2 * 3_600_000, // 2026-07-31 10:00 -> deleted
      DAY_MS + 3 * 3_600_000, // 2026-07-31 09:00 -> deleted
      3 * DAY_MS + 1 * 3_600_000, // 2026-07-29 11:00, newest of its day -> kept
      3 * DAY_MS + 2 * 3_600_000 // 2026-07-29 10:00 -> deleted
    ],
    now
  );
  try {
    const deleted = await pruneVersionHistory(doc.id, now);
    assert.equal(deleted, 3);
    const remaining = await db.documentVersion.findMany({
      where: { documentId: doc.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true }
    });
    assert.deepEqual(
      remaining.map((v) => v.createdAt.toISOString()),
      [
        new Date(now - 60_000).toISOString(),
        "2026-07-31T11:00:00.000Z",
        "2026-07-29T11:00:00.000Z"
      ]
    );
  } finally {
    await cleanup(user.id);
  }
});

test("pruning is idempotent", async () => {
  const now = new Date("2026-08-01T12:00:00Z").getTime();
  const { doc, user } = await makeDocWithVersions(
    [60_000, DAY_MS + 3_600_000, DAY_MS + 2 * 3_600_000],
    now
  );
  try {
    assert.equal(await pruneVersionHistory(doc.id, now), 1);
    assert.equal(await pruneVersionHistory(doc.id, now), 0);
  } finally {
    await cleanup(user.id);
  }
});
