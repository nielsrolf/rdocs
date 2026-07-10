import { scrubSerializedDocumentCapabilities } from "@/lib/content";
import { db } from "@/lib/db";

export async function migratePersistedDocumentCapabilities() {
  const [documents, versions] = await Promise.all([
    db.document.findMany({ select: { id: true, content: true } }),
    db.documentVersion.findMany({ select: { id: true, content: true } })
  ]);

  const documentUpdates = documents.flatMap((row) => {
    const content = scrubSerializedDocumentCapabilities(row.content);
    return content === row.content ? [] : [{ id: row.id, content }];
  });
  const versionUpdates = versions.flatMap((row) => {
    const content = scrubSerializedDocumentCapabilities(row.content);
    return content === row.content ? [] : [{ id: row.id, content }];
  });

  const operations = [
    ...documentUpdates.map((row) => db.document.update({ where: { id: row.id }, data: { content: row.content } })),
    ...versionUpdates.map((row) =>
      db.documentVersion.update({ where: { id: row.id }, data: { content: row.content } })
    )
  ];
  for (let index = 0; index < operations.length; index += 100) {
    await db.$transaction(operations.slice(index, index + 100));
  }

  return { documents: documentUpdates.length, versions: versionUpdates.length };
}
