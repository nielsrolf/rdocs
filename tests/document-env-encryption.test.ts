import assert from "node:assert/strict";
import test from "node:test";

import { db } from "../lib/db";
import { loadDocumentEnv, upsertDocumentEnv } from "../lib/document-env";

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");

async function fixture() {
  const user = await db.user.create({
    data: {
      email: `env-encryption-${Date.now()}-${Math.random()}@example.com`,
      name: "Env encryption test",
      passwordHash: "unused"
    }
  });
  const document = await db.document.create({
    data: { title: "Encrypted env", content: JSON.stringify({ type: "doc", content: [] }), ownerId: user.id }
  });
  return { user, document };
}

test("document environment values are encrypted at rest and decrypted for agent use", async () => {
  const { user, document } = await fixture();
  try {
    await upsertDocumentEnv(document.id, "API_SECRET", "very-secret-value");
    const stored = await db.documentEnvVar.findUniqueOrThrow({
      where: { documentId_key: { documentId: document.id, key: "API_SECRET" } },
      select: { value: true }
    });
    assert.notEqual(stored.value, "very-secret-value");
    assert.doesNotMatch(stored.value, /very-secret-value/);
    assert.equal((await loadDocumentEnv(document.id)).API_SECRET, "very-secret-value");
  } finally {
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test("reading a legacy plaintext document value migrates it to ciphertext", async () => {
  const { user, document } = await fixture();
  try {
    await db.documentEnvVar.create({
      data: { documentId: document.id, key: "LEGACY_SECRET", value: "legacy-plaintext" }
    });
    assert.equal((await loadDocumentEnv(document.id)).LEGACY_SECRET, "legacy-plaintext");
    const migrated = await db.documentEnvVar.findUniqueOrThrow({
      where: { documentId_key: { documentId: document.id, key: "LEGACY_SECRET" } },
      select: { value: true }
    });
    assert.notEqual(migrated.value, "legacy-plaintext");
  } finally {
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});
