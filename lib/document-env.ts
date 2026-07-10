import { maskSecret, type DocumentEnv } from "@/lib/agent-env";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "@/lib/secret-crypto";

function plaintextValue(stored: string) {
  return isEncryptedSecret(stored) ? decryptSecret(stored) : stored;
}

async function migrateRows(rows: Array<{ id: string; value: string }>) {
  const legacy = rows.filter((row) => !isEncryptedSecret(row.value));
  if (legacy.length === 0) return 0;
  await db.$transaction(
    legacy.map((row) =>
      db.documentEnvVar.update({
        where: { id: row.id },
        data: { value: encryptSecret(row.value) }
      })
    )
  );
  return legacy.length;
}

/** Full key→value map for a document, for injection into the agent env. */
export async function loadDocumentEnv(documentId: string): Promise<DocumentEnv> {
  const rows = await db.documentEnvVar.findMany({
    where: { documentId },
    select: { id: true, key: true, value: true }
  });
  const env: DocumentEnv = {};
  for (const row of rows) {
    env[row.key] = plaintextValue(row.value);
  }
  await migrateRows(rows);
  return env;
}

/** Whether a document has a given env key configured, without loading values. */
export async function hasDocumentEnvKey(documentId: string, key: string): Promise<boolean> {
  const count = await db.documentEnvVar.count({ where: { documentId, key } });
  return count > 0;
}

export type MaskedEnvVar = { key: string; masked: string; updatedAt: string };

/** Keys with masked values — safe to return over the API / show in the UI. */
export async function listDocumentEnvMasked(documentId: string): Promise<MaskedEnvVar[]> {
  const rows = await db.documentEnvVar.findMany({
    where: { documentId },
    orderBy: { key: "asc" },
    select: { id: true, key: true, value: true, updatedAt: true }
  });
  const result = rows.map((row) => ({
    key: row.key,
    masked: maskSecret(plaintextValue(row.value)),
    updatedAt: row.updatedAt.toISOString()
  }));
  await migrateRows(rows);
  return result;
}

export async function upsertDocumentEnv(documentId: string, key: string, value: string): Promise<void> {
  await db.documentEnvVar.upsert({
    where: { documentId_key: { documentId, key } },
    create: { documentId, key, value: encryptSecret(value) },
    update: { value: encryptSecret(value) }
  });
}

export async function migrateDocumentEnvEncryption(): Promise<number> {
  const rows = await db.documentEnvVar.findMany({ select: { id: true, value: true } });
  return migrateRows(rows);
}

export async function deleteDocumentEnv(documentId: string, key: string): Promise<void> {
  await db.documentEnvVar
    .delete({ where: { documentId_key: { documentId, key } } })
    .catch(() => undefined);
}
