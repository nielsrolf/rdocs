import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  parseSkillFrontmatter,
  prepareSkillUpload,
  sanitizeSkillName,
  type PreparedSkill,
  type SkillUploadFile
} from "@/lib/skills";

const execFileAsync = promisify(execFile);

// Curated skill catalog: a public git repo whose top-level directories are
// skills (each with a SKILL.md). Users install them with one click into their
// library or straight onto a document. Overridable for tests/self-hosters.
const DEFAULT_CATALOG_GIT_URL = "https://github.com/longtermrisk/claude-skills.git";

function catalogGitUrl() {
  return process.env.SKILL_CATALOG_GIT_URL?.trim() || DEFAULT_CATALOG_GIT_URL;
}

// Shallow clone cache. Lives next to the other on-disk stores, outside any
// git workspace, and is refreshed at most once per TTL.
const CATALOG_CACHE_ROOT = path.join(process.cwd(), ".skill-catalog");
const CATALOG_TTL_MS = 10 * 60 * 1000;

const MAX_CATALOG_SKILL_FILES = 200;
const MAX_CATALOG_FILE_BYTES = 5 * 1024 * 1024;

export type CatalogSkill = {
  name: string;
  description: string | null;
};

// Serialize refreshes: concurrent requests share one in-flight clone instead
// of racing `git clone` into the same directory.
let refreshPromise: Promise<string> | null = null;

async function cloneDirFor(url: string) {
  // One cache dir per catalog URL so switching SKILL_CATALOG_GIT_URL (tests!)
  // never serves a stale clone of a different repo.
  const slug = url.replace(/[^a-zA-Z0-9]+/g, "-").slice(-80);
  return path.join(CATALOG_CACHE_ROOT, slug);
}

async function isFresh(dir: string) {
  try {
    const stat = await fs.stat(path.join(dir, ".catalog-synced"));
    return Date.now() - stat.mtimeMs < CATALOG_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Ensure a reasonably fresh shallow clone of the catalog repo and return its
 * path. Clones into a temp dir and renames atomically so concurrent readers
 * never observe a half-written checkout; falls back to a stale clone when the
 * refresh fails (offline, GitHub hiccup) rather than erroring.
 */
export async function ensureCatalogClone(): Promise<string> {
  const url = catalogGitUrl();
  const dir = await cloneDirFor(url);
  if (await isFresh(dir)) return dir;
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
      try {
        await fs.mkdir(CATALOG_CACHE_ROOT, { recursive: true });
        await execFileAsync("git", ["clone", "--depth", "1", "--quiet", url, tmp], {
          timeout: 60_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
        });
        await fs.writeFile(path.join(tmp, ".catalog-synced"), new Date().toISOString());
        await fs.rm(dir, { recursive: true, force: true });
        await fs.rename(tmp, dir);
      } catch (error) {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
        // Serve a stale clone if we have one; otherwise surface the failure.
        const hasStale = await fs
          .stat(path.join(dir, ".catalog-synced"))
          .then(() => true)
          .catch(() => false);
        if (!hasStale) {
          throw new Error(
            `Could not fetch the skill catalog (${url}): ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      return dir;
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

type CatalogEntry = CatalogSkill & {
  // Directory inside the clone (may differ from the frontmatter name).
  dir: string;
  // Git tree id of that directory at the clone's HEAD: changes exactly when
  // any file of the skill changes, so installs can tell whether to refresh.
  version: string | null;
};

async function catalogTreeVersions(cloneDir: string) {
  const versions = new Map<string, string>();
  const { stdout } = await execFileAsync("git", ["ls-tree", "HEAD"], { cwd: cloneDir }).catch(() => ({
    stdout: ""
  }));
  for (const line of stdout.split("\n")) {
    // "<mode> tree <sha>\t<name>"
    const match = /^\d+ tree ([0-9a-f]+)\t(.+)$/.exec(line);
    if (match) versions.set(match[2], match[1]);
  }
  return versions;
}

async function readCatalogEntries(cloneDir: string): Promise<CatalogEntry[]> {
  const entries = await fs.readdir(cloneDir, { withFileTypes: true });
  const versions = await catalogTreeVersions(cloneDir);
  const skills: CatalogEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillMd = await fs
      .readFile(path.join(cloneDir, entry.name, "SKILL.md"), "utf8")
      .catch(() => null);
    if (skillMd === null) continue;
    const frontmatter = parseSkillFrontmatter(skillMd);
    const name = sanitizeSkillName(frontmatter.name ?? entry.name);
    if (!name) continue;
    skills.push({
      name,
      description: frontmatter.description,
      dir: path.join(cloneDir, entry.name),
      version: versions.get(entry.name) ?? null
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * List installable skills: every top-level directory of the catalog repo that
 * contains a SKILL.md, with name/description read from its frontmatter.
 */
export async function listCatalogSkills(): Promise<CatalogSkill[]> {
  const entries = await readCatalogEntries(await ensureCatalogClone());
  return entries.map(({ name, description }) => ({ name, description }));
}

/** Current catalog version (git tree id) per skill name. */
export async function catalogSkillVersions(): Promise<Map<string, string | null>> {
  const entries = await readCatalogEntries(await ensureCatalogClone());
  return new Map(entries.map((entry) => [entry.name, entry.version]));
}

async function collectSkillFiles(root: string): Promise<SkillUploadFile[]> {
  const files: SkillUploadFile[] = [];
  async function walk(current: string, relative: string) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(current, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        if (files.length >= MAX_CATALOG_SKILL_FILES) {
          throw new Error("Catalog skill contains too many files.");
        }
        const stat = await fs.stat(abs);
        if (stat.size > MAX_CATALOG_FILE_BYTES) continue; // skip oversized assets
        files.push({ relativePath: rel, bytes: await fs.readFile(abs) });
      }
    }
  }
  await walk(root, "");
  return files;
}

/**
 * Load one catalog skill as a PreparedSkill ready for writeSkillToStore,
 * together with its catalog version. `requestedName` is matched against the
 * sanitized catalog listing, so it can never address a path outside the
 * clone. Returns null when no such skill exists in the catalog.
 */
export async function loadCatalogSkillVersioned(
  requestedName: string
): Promise<{ skill: PreparedSkill; version: string | null } | null> {
  const wanted = sanitizeSkillName(requestedName);
  if (!wanted) return null;
  const entries = await readCatalogEntries(await ensureCatalogClone());
  const entry = entries.find((candidate) => candidate.name === wanted);
  if (!entry) return null;
  // Reuse the upload pipeline: same sanitization, size limits and
  // frontmatter-derived naming as a manual skill folder upload.
  return { skill: prepareSkillUpload(await collectSkillFiles(entry.dir)), version: entry.version };
}

export async function loadCatalogSkill(requestedName: string): Promise<PreparedSkill | null> {
  return (await loadCatalogSkillVersioned(requestedName))?.skill ?? null;
}

// Tests: make the next ensureCatalogClone() re-clone instead of serving the
// TTL-fresh copy.
export async function expireCatalogCacheForTests() {
  await fs.rm(path.join(await cloneDirFor(catalogGitUrl()), ".catalog-synced"), { force: true });
}
