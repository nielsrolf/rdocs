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

// Admin secrets a PROVISIONER document holds to mint credentials for other
// workspaces (lib/litellm-provisioning.ts). They are used server-side only and
// are NEVER given to an agent run: an agent that could read the admin key
// could mint unbudgeted keys or copy it anywhere. loadDocumentEnv (the source
// of every run env) drops them; loadProvisionerEnv is the only reader.
export const PROVISIONER_SECRET_ENV_KEYS: ReadonlySet<string> = new Set(["LITELLM_ADMIN_KEY"]);

export function isProvisionerSecretEnvKey(key: string): boolean {
  return PROVISIONER_SECRET_ENV_KEYS.has(key);
}

async function loadAllDocumentEnv(documentId: string): Promise<DocumentEnv> {
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

/**
 * Full key→value map for a document, for injection into the agent env.
 * Provisioner admin secrets are withheld (see PROVISIONER_SECRET_ENV_KEYS).
 */
export async function loadDocumentEnv(documentId: string): Promise<DocumentEnv> {
  const env = await loadAllDocumentEnv(documentId);
  for (const key of PROVISIONER_SECRET_ENV_KEYS) delete env[key];
  return env;
}

/** Server-side only: the document env INCLUDING provisioner admin secrets. */
export async function loadProvisionerEnv(documentId: string): Promise<DocumentEnv> {
  return loadAllDocumentEnv(documentId);
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

/**
 * Copy env vars from one document to another WITHOUT exposing their values to
 * the caller (agent "pass this key on" flows). Copies the stored ciphertext
 * and the secret flag. Returns the keys that were missing on the source;
 * nothing is written when any key is missing.
 */
export async function copyDocumentEnvKeys(
  fromDocumentId: string,
  toDocumentId: string,
  keys: string[]
): Promise<{ copied: string[]; missing: string[] }> {
  const rows = await db.documentEnvVar.findMany({
    where: { documentId: fromDocumentId, key: { in: keys } },
    select: { key: true, value: true, isSecret: true }
  });
  const found = new Set(rows.map((row) => row.key));
  const missing = keys.filter((key) => !found.has(key));
  if (missing.length > 0) return { copied: [], missing };
  await db.$transaction(
    rows.map((row) => {
      const value = isEncryptedSecret(row.value) ? row.value : encryptSecret(row.value);
      return db.documentEnvVar.upsert({
        where: { documentId_key: { documentId: toDocumentId, key: row.key } },
        create: { documentId: toDocumentId, key: row.key, value, isSecret: row.isSecret },
        update: { value, isSecret: row.isSecret }
      });
    })
  );
  return { copied: rows.map((row) => row.key), missing: [] };
}
