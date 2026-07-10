import { db } from "../lib/db";
import { migrateDocumentEnvEncryption } from "../lib/document-env";

async function main() {
  const migrated = await migrateDocumentEnvEncryption();
  console.log(`[document-env-migration] encrypted ${migrated} legacy value(s)`);
}

main().finally(() => db.$disconnect());
