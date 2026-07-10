import { db } from "../lib/db";
import { migratePersistedDocumentCapabilities } from "../lib/document-capability-migration";
import { migrateDocumentEnvEncryption } from "../lib/document-env";

async function main() {
  const encryptedEnvValues = await migrateDocumentEnvEncryption();
  const scrubbedCapabilities = await migratePersistedDocumentCapabilities();
  console.log(
    `[security-data-migration] encrypted ${encryptedEnvValues} environment value(s); scrubbed ${scrubbedCapabilities.documents} document(s) and ${scrubbedCapabilities.versions} version(s)`
  );
}

main().finally(() => db.$disconnect());
