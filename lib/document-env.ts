import { maskSecret, type DocumentEnv } from "@/lib/agent-env";
import { db } from "@/lib/db";

/** Full key→value map for a document, for injection into the agent env. */
export async function loadDocumentEnv(documentId: string): Promise<DocumentEnv> {
  const rows = await db.documentEnvVar.findMany({
    where: { documentId },
    select: { key: true, value: true }
  });
  const env: DocumentEnv = {};
  for (const row of rows) {
    env[row.key] = row.value;
  }
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
    select: { key: true, value: true, updatedAt: true }
  });
  return rows.map((row) => ({
    key: row.key,
    masked: maskSecret(row.value),
    updatedAt: row.updatedAt.toISOString()
  }));
}

export async function upsertDocumentEnv(documentId: string, key: string, value: string): Promise<void> {
  await db.documentEnvVar.upsert({
    where: { documentId_key: { documentId, key } },
    create: { documentId, key, value },
    update: { value }
  });
}

export async function deleteDocumentEnv(documentId: string, key: string): Promise<void> {
  await db.documentEnvVar
    .delete({ where: { documentId_key: { documentId, key } } })
    .catch(() => undefined);
}
