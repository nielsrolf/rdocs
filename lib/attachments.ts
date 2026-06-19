import fs from "node:fs/promises";
import path from "node:path";

const WORKSPACE_ROOT = path.join(process.cwd(), ".research-workspaces");

// Directory name (relative to a worktree / the per-document store) that holds
// uploaded attachments. Mirrored into every agent worktree so the agent can read
// the files at `attachments/<storedName>`.
export const ATTACHMENTS_DIRNAME = "attachments";

// Per-document attachment store: a sibling of the repo checkout + worktrees dirs,
// outside any git workspace. Survives worktree GC and is never committed/pushed.
export function getAttachmentsStoreDir(documentId: string) {
  return path.join(WORKSPACE_ROOT, documentId, ATTACHMENTS_DIRNAME);
}

export function getAttachmentStorePath(documentId: string, storedName: string) {
  return path.join(getAttachmentsStoreDir(documentId), storedName);
}

// Workspace-relative path the agent (and markdown serialization) reference.
export function getAttachmentWorkspacePath(storedName: string) {
  return `${ATTACHMENTS_DIRNAME}/${storedName}`;
}

// Reduce an arbitrary upload name to a safe single path segment. Keeps the
// extension, strips directories and anything that isn't filename-friendly so the
// agent sees a recognizable name and a path traversal can't escape the dir.
export function sanitizeFileName(name: string) {
  const base = path.basename(name || "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+/, "");
  const trimmed = base.slice(0, 120).replace(/-+$/, "");
  return trimmed || "attachment";
}

// Pick a storedName that does not collide with an existing file in the store.
// Appends -1, -2, ... before the extension on collision.
async function uniqueStoredName(dir: string, desired: string) {
  const ext = path.extname(desired);
  const stem = desired.slice(0, desired.length - ext.length);
  let candidate = desired;
  let counter = 1;
  // Bounded loop — give up after a sane number of attempts and let the write
  // overwrite rather than spin forever.
  while (counter < 1000) {
    const exists = await fs
      .stat(path.join(dir, candidate))
      .then(() => true)
      .catch(() => false);
    if (!exists) return candidate;
    candidate = `${stem}-${counter}${ext}`;
    counter += 1;
  }
  return candidate;
}

export async function saveAttachmentToStore(documentId: string, fileName: string, bytes: Buffer) {
  const dir = getAttachmentsStoreDir(documentId);
  await fs.mkdir(dir, { recursive: true });
  const storedName = await uniqueStoredName(dir, sanitizeFileName(fileName));
  await fs.writeFile(path.join(dir, storedName), bytes);
  return { storedName, workspacePath: getAttachmentWorkspacePath(storedName) };
}

export async function deleteAttachmentFromStore(documentId: string, storedName: string) {
  await fs.rm(getAttachmentStorePath(documentId, storedName), { force: true }).catch(() => undefined);
}

async function listStoredAttachmentFiles(documentId: string) {
  try {
    const entries = await fs.readdir(getAttachmentsStoreDir(documentId), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name !== ".gitignore").map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Copy the document's stored attachments into a freshly created worktree so the
// agent can read them at `attachments/<storedName>`. A self-ignoring `.gitignore`
// (`*`) keeps `git add -A` / status from ever committing or pushing uploads into
// the linked repo. Best-effort: a copy failure must not block the agent run.
export async function syncAttachmentsIntoWorktree(documentId: string, worktreePath: string) {
  const files = await listStoredAttachmentFiles(documentId);
  if (files.length === 0) return;

  const targetDir = path.join(worktreePath, ATTACHMENTS_DIRNAME);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(targetDir, ".gitignore"), "*\n").catch(() => undefined);

  for (const name of files) {
    await fs
      .copyFile(getAttachmentStorePath(documentId, name), path.join(targetDir, name))
      .catch(() => undefined);
  }
}

// Human-readable listing of the document's attachments, appended to the agent's
// workspace overview so it knows the files exist and where to read them.
export async function describeAttachmentsForOverview(documentId: string) {
  const files = await listStoredAttachmentFiles(documentId);
  if (files.length === 0) return "";
  const lines = files.map((name) => `- ${getAttachmentWorkspacePath(name)}`).join("\n");
  return `User-uploaded attachments (read-only, available in this workspace):\n${lines}`;
}
