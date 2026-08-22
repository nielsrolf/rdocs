// One-off backfill of DocumentVersion retention.
//
// pruneVersionHistory only runs on the save path (lib/document-data.ts), so a
// document that stops being edited keeps its unthinned history forever. That is
// how dev.db reached 4.6GB again after the 2026-08-01 prune: 6.5k stale
// snapshots averaging 500KB each, five documents pegged at the 500 cap.
//
// This walks every document and applies the SAME tested retention rules
// (tests/version-retention.test.ts) so the logic cannot drift from production.
//
//   npx tsx scripts/prune-all-version-history.ts --dry-run
//   npx tsx scripts/prune-all-version-history.ts
//
// VACUUM afterwards to actually return the pages to the filesystem.
import { db } from "@/lib/db";
import { pruneVersionHistory } from "@/lib/document-data";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const before = await db.documentVersion.count();
  const docs = await db.document.findMany({ select: { id: true } });
  console.log(`${docs.length} documents, ${before} versions${dryRun ? " (dry run)" : ""}`);

  let deleted = 0;
  let touched = 0;

  for (const [index, doc] of docs.entries()) {
    if (dryRun) {
      // Mirror the retention predicate read-only: keep everything inside the
      // full-retention window, then the newest per UTC day, capped per doc.
      const versions = await db.documentVersion.findMany({
        where: { documentId: doc.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { createdAt: true }
      });
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const seenDays = new Set<string>();
      let excess = 0;
      versions.forEach((version, position) => {
        if (position >= 500) return excess++;
        if (version.createdAt.getTime() >= cutoff) return;
        const day = version.createdAt.toISOString().slice(0, 10);
        if (seenDays.has(day)) excess++;
        else seenDays.add(day);
      });
      if (excess > 0) {
        deleted += excess;
        touched++;
      }
    } else {
      const removed = await pruneVersionHistory(doc.id);
      if (removed > 0) {
        deleted += removed;
        touched++;
      }
    }

    if ((index + 1) % 1000 === 0) {
      console.log(`  ${index + 1}/${docs.length} documents, ${deleted} versions so far`);
    }
  }

  const after = dryRun ? before : await db.documentVersion.count();
  console.log(
    `${dryRun ? "would delete" : "deleted"} ${deleted} versions across ${touched} documents; ` +
      `${before} -> ${after} rows`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
