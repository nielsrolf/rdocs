import { maskSecret, type DocumentEnv } from "@/lib/agent-env";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "@/lib/secret-crypto";

function plaintextValue(stored: string) {
  return isEncryptedSecret(stored) ? decryptSecret(stored) : stored;
}

// Heuristic: does this env var NAME look like a credential? Used when the user
// has not set DocumentEnvVar.isSecret explicitly (null = auto). Secrets are
// masked in the UI and eligible for credential-broker substitution; plain
// config vars (URLs, model names, flags) are shown in full and always pass
// through to the agent verbatim.
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

export function isSecretEnvKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** Effective secret flag: explicit user choice, else the name heuristic. */
export function effectiveIsSecret(key: string, isSecret: boolean | null): boolean {
  return isSecret ?? isSecretEnvKey(key);
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

export type MaskedEnvVar = {
  key: string;
  /** Masked for secrets; the FULL value for plain config vars. */
  masked: string;
  updatedAt: string;
  /** Effective classification (explicit choice, else name heuristic). */
  isSecret: boolean;
  /** True when isSecret is the heuristic default rather than a user choice. */
  isSecretAuto: boolean;
};

/** Keys with display values — safe to return over the API / show in the UI. */
export async function listDocumentEnvMasked(documentId: string): Promise<MaskedEnvVar[]> {
  const rows = await db.documentEnvVar.findMany({
    where: { documentId },
    orderBy: { key: "asc" },
    select: { id: true, key: true, value: true, updatedAt: true, isSecret: true }
  });
  const result = rows.map((row) => {
    const secret = effectiveIsSecret(row.key, row.isSecret);
    const value = plaintextValue(row.value);
    return {
      key: row.key,
      masked: secret ? maskSecret(value) : value,
      updatedAt: row.updatedAt.toISOString(),
      isSecret: secret,
      isSecretAuto: row.isSecret === null
    };
  });
  await migrateRows(rows);
  return result;
}

export async function upsertDocumentEnv(
  documentId: string,
  key: string,
  value: string,
  isSecret: boolean | null | undefined = undefined
): Promise<void> {
  await db.documentEnvVar.upsert({
    where: { documentId_key: { documentId, key } },
    create: { documentId, key, value: encryptSecret(value), isSecret: isSecret ?? null },
    update: { value: encryptSecret(value), ...(isSecret === undefined ? {} : { isSecret }) }
  });
}

/** Set (true/false) or reset (null = auto) a var's secret classification. */
export async function setDocumentEnvSecretFlag(
  documentId: string,
  key: string,
  isSecret: boolean | null
): Promise<boolean> {
  const result = await db.documentEnvVar.updateMany({
    where: { documentId, key },
    data: { isSecret }
  });
  return result.count > 0;
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
