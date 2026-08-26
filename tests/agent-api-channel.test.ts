import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  resolveAgentApiChannel,
  revokeAgentApiChannel,
  upsertAgentApiChannel
} from "../lib/agent-api-channels";
import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";

async function fixture() {
  const user = await db.user.create({
    data: { email: `agent-api-${crypto.randomUUID()}@example.com`, name: "Agent API", passwordHash: "x" }
  });
  const document = await db.document.create({
    data: {
      ownerId: user.id,
      title: "API agent",
      content: serializeDocumentContent({ type: "doc", content: [{ type: "paragraph" }] })
    }
  });
  return { user, document };
}

test("agent API channels are document-scoped, rotatable, and revocable", async () => {
  const { user, document } = await fixture();
  try {
    const first = await upsertAgentApiChannel({
      documentId: document.id,
      createdById: user.id,
      label: "forecasting"
    });
    assert.match(first.token, /^gdach_[0-9a-f]{48}$/);

    const resolved = await resolveAgentApiChannel(first.channel.id, `Bearer ${first.token}`);
    assert.equal(resolved?.documentId, document.id);
    assert.equal(resolved?.createdById, user.id);
    assert.equal(await resolveAgentApiChannel("wrong-trigger", `Bearer ${first.token}`), null);

    const rotated = await upsertAgentApiChannel({
      documentId: document.id,
      createdById: user.id,
      label: "forecasting"
    });
    assert.equal(rotated.channel.id, first.channel.id);
    assert.equal(await resolveAgentApiChannel(first.channel.id, `Bearer ${first.token}`), null);
    assert.equal((await resolveAgentApiChannel(rotated.channel.id, `Bearer ${rotated.token}`))?.documentId,
      document.id);

    assert.equal(await revokeAgentApiChannel(document.id, user.id), true);
    assert.equal(await resolveAgentApiChannel(rotated.channel.id, `Bearer ${rotated.token}`), null);
  } finally {
    await db.document.delete({ where: { id: document.id } }).catch(() => null);
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
  }
});
