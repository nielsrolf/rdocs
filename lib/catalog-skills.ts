import fs from "node:fs/promises";

import { db } from "@/lib/db";
import { catalogSkillVersions, loadCatalogSkillVersioned } from "@/lib/skill-catalog";
import { getDocumentSkillDir, getUserSkillDir, syncSkillsIntoWorktree, writeSkillToStore } from "@/lib/skills";

// Skills installed from the catalog FOLLOW the catalog: each row remembers
// its catalog name and the git tree id it was written from, and every run
// (plus every library listing) rewrites stored copies whose catalog tree has
// moved on. Uploaded skills (catalogName null) are never touched, and an
// unreachable catalog keeps the stored copy — a refresh never fails a run.

type CatalogTrackedRow = {
  id: string;
  name: string;
  catalogName: string | null;
  catalogVersion: string | null;
};

async function refreshRows(
  rows: CatalogTrackedRow[],
  skillDir: (name: string) => string,
  save: (id: string, data: { description: string | null; catalogVersion: string | null }) => Promise<unknown>,
  context: Record<string, string>
) {
  const tracked = rows.filter((row) => row.catalogName);
  if (tracked.length === 0) return;

  let versions: Map<string, string | null>;
  try {
    versions = await catalogSkillVersions();
  } catch (error) {
    console.warn("[skills] catalog unreachable; keeping stored catalog skills", {
      ...context,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  for (const row of tracked) {
    const catalogName = row.catalogName as string;
    // Removed from the catalog (or renamed): keep what is installed.
    if (!versions.has(catalogName)) continue;
    const current = versions.get(catalogName) ?? null;
    const present = await fs
      .stat(skillDir(row.name))
      .then(() => true)
      .catch(() => false);
    if (present && current !== null && current === row.catalogVersion) continue;
    try {
      const loaded = await loadCatalogSkillVersioned(catalogName);
      if (!loaded) continue;
      await writeSkillToStore(skillDir(row.name), loaded.skill);
      await save(row.id, { description: loaded.skill.description, catalogVersion: loaded.version });
      console.log("[skills] refreshed catalog skill", {
        ...context,
        skill: row.name,
        from: row.catalogVersion,
        to: loaded.version
      });
    } catch (error) {
      console.warn("[skills] catalog skill refresh failed; keeping stored copy", {
        ...context,
        skill: row.name,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

// Concurrent runs of one document share one refresh (globalThis: route
// handlers and instrumentation live in different module contexts).
const IN_FLIGHT_KEY = "__rdocsCatalogSkillRefreshes";
function inFlight(): Map<string, Promise<void>> {
  const holder = globalThis as unknown as Record<string, Map<string, Promise<void>> | undefined>;
  return (holder[IN_FLIGHT_KEY] ??= new Map());
}

function once(key: string, work: () => Promise<void>) {
  const map = inFlight();
  const existing = map.get(key);
  if (existing) return existing;
  const promise = work().finally(() => map.delete(key));
  map.set(key, promise);
  return promise;
}

export function refreshDocumentCatalogSkills(documentId: string) {
  return once(`document:${documentId}`, async () => {
    const rows = await db.documentSkill.findMany({
      where: { documentId, catalogName: { not: null } },
      select: { id: true, name: true, catalogName: true, catalogVersion: true }
    });
    await refreshRows(
      rows,
      (name) => getDocumentSkillDir(documentId, name),
      (id, data) => db.documentSkill.update({ where: { id }, data }),
      { documentId }
    );
  });
}

export function refreshUserCatalogSkills(userId: string) {
  return once(`user:${userId}`, async () => {
    const rows = await db.userSkill.findMany({
      where: { userId, catalogName: { not: null } },
      select: { id: true, name: true, catalogName: true, catalogVersion: true }
    });
    await refreshRows(
      rows,
      (name) => getUserSkillDir(userId, name),
      (id, data) => db.userSkill.update({ where: { id }, data }),
      { userId }
    );
  });
}

/** Run start: bring catalog skills up to date, then materialize all skills. */
export async function syncDocumentSkillsForRun(documentId: string, worktreePath: string) {
  await refreshDocumentCatalogSkills(documentId).catch((error) => {
    console.warn("[skills] catalog skill refresh crashed", {
      documentId,
      error: error instanceof Error ? error.message : String(error)
    });
  });
  await syncSkillsIntoWorktree(documentId, worktreePath);
}

/** One-click catalog install onto a document. Null when the catalog has no such skill. */
export async function installCatalogSkillOnDocument(documentId: string, catalogName: string, userId: string | null) {
  const loaded = await loadCatalogSkillVersioned(catalogName);
  if (!loaded) return null;
  const { skill, version } = loaded;
  await writeSkillToStore(getDocumentSkillDir(documentId, skill.name), skill);
  const tracking = { description: skill.description, catalogName: skill.name, catalogVersion: version };
  return db.documentSkill.upsert({
    where: { documentId_name: { documentId, name: skill.name } },
    create: { documentId, name: skill.name, createdById: userId, ...tracking },
    update: tracking
  });
}

/** One-click catalog install into a user's library. */
export async function installCatalogSkillInLibrary(userId: string, catalogName: string, isDefault: boolean) {
  const loaded = await loadCatalogSkillVersioned(catalogName);
  if (!loaded) return null;
  const { skill, version } = loaded;
  await writeSkillToStore(getUserSkillDir(userId, skill.name), skill);
  const tracking = { description: skill.description, catalogName: skill.name, catalogVersion: version };
  return db.userSkill.upsert({
    where: { userId_name: { userId, name: skill.name } },
    create: { userId, name: skill.name, isDefault, ...tracking },
    update: tracking
  });
}

// An upload under an existing name replaces the skill with the user's own
// version, which must stop following the catalog.
export const UNTRACKED_SKILL = { catalogName: null, catalogVersion: null } as const;
