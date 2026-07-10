import { Prisma } from "@prisma/client";

import { scrubSerializedDocumentCapabilities } from "@/lib/content";
import { db } from "@/lib/db";

// DocumentVersion holds gigabytes of content across all rows; loading the
// whole table in one findMany overflows Node's string-conversion limits
// (`Failed to convert rust String into napi string`), so page by cursor.
const PAGE_SIZE = 100;

async function applyInChunks(operations: Prisma.PrismaPromise<unknown>[]) {
  for (let index = 0; index < operations.length; index += 100) {
    await db.$transaction(operations.slice(index, index + 100));
  }
}

export async function migratePersistedDocumentCapabilities() {
  const documents = await db.document.findMany({ select: { id: true, content: true } });
  const documentUpdates = documents.flatMap((row) => {
    const content = scrubSerializedDocumentCapabilities(row.content);
    return content === row.content ? [] : [{ id: row.id, content }];
  });
  await applyInChunks(
    documentUpdates.map((row) => db.document.update({ where: { id: row.id }, data: { content: row.content } }))
  );

  let versionUpdates = 0;
  let cursor: string | null = null;
  for (;;) {
    const versions: { id: string; content: string }[] = await db.documentVersion.findMany({
      select: { id: true, content: true },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    if (versions.length === 0) break;
    cursor = versions[versions.length - 1].id;

    const operations = versions.flatMap((row) => {
      const content = scrubSerializedDocumentCapabilities(row.content);
      return content === row.content
        ? []
        : [db.documentVersion.update({ where: { id: row.id }, data: { content } })];
    });
    await applyInChunks(operations);
    versionUpdates += operations.length;
  }

  return { documents: documentUpdates.length, versions: versionUpdates };
}
