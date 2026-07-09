import fs from "node:fs/promises";
import path from "node:path";

const WORKSPACE_ROOT = path.join(process.cwd(), ".research-workspaces");
// Per-user skill libraries live outside .research-workspaces so they can't be
// confused with (or GC'd like) per-document workspace state.
const USER_SKILLS_ROOT = path.join(process.cwd(), ".user-skills");

// Where skills are materialized inside an agent worktree. This is the Claude
// Agent SDK's project-skill discovery path relative to the run's cwd.
export const WORKTREE_SKILLS_DIRNAME = path.join(".claude", "skills");

const MAX_SKILL_FILES = 200;
const MAX_SKILL_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_PATH_DEPTH = 8;
const MAX_SKILL_NAME_LENGTH = 64;

export type SkillUploadFile = {
  // Upload-relative path (e.g. from webkitRelativePath); may use / or \.
  relativePath: string;
  bytes: Buffer;
};

export type PreparedSkill = {
  name: string;
  description: string | null;
  // Skill-root-relative sanitized path -> content.
  files: Map<string, Buffer>;
};

export function getUserSkillsStoreDir(userId: string) {
  return path.join(USER_SKILLS_ROOT, userId);
}

export function getUserSkillDir(userId: string, name: string) {
  return path.join(getUserSkillsStoreDir(userId), name);
}

// Per-document skill store: sibling of the attachments dir, outside any git
// workspace. Survives worktree GC and is never committed/pushed.
export function getDocumentSkillsStoreDir(documentId: string) {
  return path.join(WORKSPACE_ROOT, documentId, "skills");
}

export function getDocumentSkillDir(documentId: string, name: string) {
  return path.join(getDocumentSkillsStoreDir(documentId), name);
}

// Skill names double as directory names and as the identifiers passed to the
// SDK's `skills` allowlist, so keep them to a conservative slug.
export function sanitizeSkillName(name: string) {
  const slug = (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SKILL_NAME_LENGTH)
    .replace(/-+$/, "");
  return slug;
}

// Reduce an upload-relative path to a safe skill-root-relative path. Rejects
// (returns null) anything that could escape the skill directory or nest
// absurdly deep instead of silently rewriting it.
export function sanitizeSkillRelativePath(relativePath: string): string | null {
  const segments = (relativePath || "")
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.length > MAX_SKILL_PATH_DEPTH) return null;
  const cleaned: string[] = [];
  for (const segment of segments) {
    if (segment === ".." || segment.includes("\0")) return null;
    const safe = segment.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^\.+$/, "");
    if (!safe) return null;
    cleaned.push(safe.slice(0, 120));
  }
  return cleaned.join("/");
}

// Pull `name:` / `description:` out of SKILL.md YAML frontmatter without a
// yaml dependency; both are single-line values in the skill format.
export function parseSkillFrontmatter(skillMd: string): { name: string | null; description: string | null } {
  const match = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: null, description: null };
  const block = match[1];
  const read = (key: string) => {
    const line = block.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
    if (!line) return null;
    const value = line[1].trim().replace(/^["']|["']$/g, "").trim();
    return value || null;
  };
  return { name: read("name"), description: read("description")?.slice(0, 500) ?? null };
}

// Read a skill upload out of a multipart form. The client appends one `files`
// entry per file plus a parallel `paths` entry carrying its upload-relative
// path (FormData does not preserve webkitRelativePath); a missing path falls
// back to the file's own name (single-file uploads).
export async function readSkillUploadFromFormData(formData: FormData): Promise<SkillUploadFile[]> {
  const files = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
  const paths = formData.getAll("paths").map((entry) => (typeof entry === "string" ? entry : ""));
  const uploads: SkillUploadFile[] = [];
  for (let i = 0; i < files.length; i++) {
    uploads.push({
      relativePath: paths[i] || files[i].name,
      bytes: Buffer.from(await files[i].arrayBuffer())
    });
  }
  return uploads;
}

// Normalize an uploaded set of files into a skill: strips a shared top-level
// folder (browser directory uploads include it), requires a SKILL.md at the
// skill root, and derives the skill name from frontmatter or the folder name.
// Throws with a user-facing message on invalid input.
export function prepareSkillUpload(uploadFiles: SkillUploadFile[]): PreparedSkill {
  if (uploadFiles.length === 0) throw new Error("No files uploaded.");
  if (uploadFiles.length > MAX_SKILL_FILES) {
    throw new Error(`A skill can contain at most ${MAX_SKILL_FILES} files.`);
  }
  const totalBytes = uploadFiles.reduce((sum, file) => sum + file.bytes.length, 0);
  if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
    throw new Error("Skill exceeds the 20 MB size limit.");
  }

  const entries = uploadFiles.map((file) => {
    const sanitized = sanitizeSkillRelativePath(file.relativePath);
    if (!sanitized) throw new Error(`Invalid file path in upload: ${file.relativePath}`);
    return { path: sanitized, bytes: file.bytes };
  });

  // A directory upload prefixes every path with the folder name — strip that
  // shared root so SKILL.md sits at the skill root.
  const topLevel = new Set(entries.map((entry) => entry.path.split("/")[0]));
  let rootName: string | null = null;
  let files = entries;
  if (topLevel.size === 1 && entries.every((entry) => entry.path.includes("/"))) {
    rootName = [...topLevel][0];
    files = entries.map((entry) => ({ ...entry, path: entry.path.split("/").slice(1).join("/") }));
  }

  // Single markdown file upload → treat it as the SKILL.md.
  if (files.length === 1 && !files[0].path.includes("/") && /\.md$/i.test(files[0].path) && files[0].path !== "SKILL.md") {
    files = [{ ...files[0], path: "SKILL.md" }];
  }

  const skillMdEntry = files.find((entry) => entry.path === "SKILL.md");
  if (!skillMdEntry) {
    throw new Error("Skill upload must contain a SKILL.md at its root.");
  }

  const fileMap = new Map<string, Buffer>();
  for (const entry of files) {
    if (fileMap.has(entry.path)) throw new Error(`Duplicate file in upload: ${entry.path}`);
    fileMap.set(entry.path, entry.bytes);
  }

  const frontmatter = parseSkillFrontmatter(skillMdEntry.bytes.toString("utf8"));
  const name = sanitizeSkillName(frontmatter.name ?? rootName ?? "");
  if (!name) {
    throw new Error(
      "Could not determine the skill name. Add a `name:` to the SKILL.md frontmatter or upload a named folder."
    );
  }

  return { name, description: frontmatter.description, files: fileMap };
}

// Write a prepared skill into a store directory, replacing any previous
// version of the same skill wholesale (uploads are full snapshots).
export async function writeSkillToStore(skillDir: string, skill: PreparedSkill) {
  await fs.rm(skillDir, { recursive: true, force: true });
  for (const [relative, bytes] of skill.files) {
    const target = path.join(skillDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
}

export async function deleteSkillFromStore(skillDir: string) {
  await fs.rm(skillDir, { recursive: true, force: true }).catch(() => undefined);
}

// Copy a stored skill directory to another store location (user library →
// document, at creation or on explicit attach). Replaces the destination.
export async function copySkillDir(sourceDir: string, targetDir: string) {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true });
}

async function listStoredSkillDirs(documentId: string) {
  try {
    const entries = await fs.readdir(getDocumentSkillsStoreDir(documentId), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Copy the document's stored skills into a freshly created worktree at
// `.claude/skills/<name>` so the Claude Agent SDK discovers them as project
// skills. A self-ignoring `.gitignore` (`*`) keeps `git add -A` from ever
// committing materialized skills into the linked repo. Best-effort: a copy
// failure must not block the agent run.
export async function syncSkillsIntoWorktree(documentId: string, worktreePath: string) {
  const names = await listStoredSkillDirs(documentId);
  if (names.length === 0) return;

  const targetDir = path.join(worktreePath, WORKTREE_SKILLS_DIRNAME);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(targetDir, ".gitignore"), "*\n").catch(() => undefined);

  for (const name of names) {
    await fs
      .cp(getDocumentSkillDir(documentId, name), path.join(targetDir, name), { recursive: true })
      .catch(() => undefined);
  }
}
