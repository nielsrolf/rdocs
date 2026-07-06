import fs from "node:fs/promises";
import path from "node:path";

import {
  commitWorkspaceChanges,
  ensureLinkedRepository,
  withWorkspaceLock,
  type LinkedRepository
} from "@/lib/research-workspace";

export class McpFileError extends Error {}

export type UploadedFile = {
  path: string;
  // Exactly one of the two: UTF-8 text or base64 bytes.
  content?: string;
  contentBase64?: string;
};

const MAX_FILES = 32;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

// Repo-relative path guard for files written by the MCP bridge. Same posture as
// the repo-files serving route: stay inside the workspace, never touch git
// internals or the (gitignored) attachments mirror.
function resolveWorkspaceFilePath(workspace: string, relativePath: string) {
  const trimmed = relativePath.trim();
  if (!trimmed || trimmed.length > 500) {
    throw new McpFileError(`Invalid file path: "${relativePath}".`);
  }
  if (path.isAbsolute(trimmed) || trimmed.includes("\0")) {
    throw new McpFileError(`File paths must be repo-relative: "${relativePath}".`);
  }
  const normalized = path.normalize(trimmed);
  const segments = normalized.split(path.sep);
  if (segments.includes("..") || segments[0] === ".git" || segments.includes(".git")) {
    throw new McpFileError(`File path escapes the workspace: "${relativePath}".`);
  }
  if (segments[0] === "attachments") {
    throw new McpFileError('The "attachments/" directory is reserved for document uploads.');
  }
  const absolute = path.resolve(workspace, normalized);
  if (!absolute.startsWith(path.resolve(workspace) + path.sep)) {
    throw new McpFileError(`File path escapes the workspace: "${relativePath}".`);
  }
  return { absolute, relative: normalized };
}

function decodeFile(file: UploadedFile): Buffer {
  if (typeof file.contentBase64 === "string") {
    const buffer = Buffer.from(file.contentBase64, "base64");
    if (buffer.length > MAX_FILE_BYTES) {
      throw new McpFileError(`File "${file.path}" exceeds the ${MAX_FILE_BYTES / 1024 / 1024}MB limit.`);
    }
    return buffer;
  }
  if (typeof file.content === "string") {
    const buffer = Buffer.from(file.content, "utf8");
    if (buffer.length > MAX_FILE_BYTES) {
      throw new McpFileError(`File "${file.path}" exceeds the ${MAX_FILE_BYTES / 1024 / 1024}MB limit.`);
    }
    return buffer;
  }
  throw new McpFileError(`File "${file.path}" needs either "content" (text) or "content_base64".`);
}

// Write files into the document's base workspace checkout and commit them, so
// the widget/source and repo-files routes can serve them and future agent runs
// see them. Returns the commit info and the workspace.
export async function commitFilesToWorkspace(input: {
  documentId: string;
  files: UploadedFile[];
  message: string;
  userId?: string | null;
}): Promise<{ linked: LinkedRepository; commitSha: string | null; paths: string[] }> {
  if (input.files.length === 0) {
    throw new McpFileError("No files provided.");
  }
  if (input.files.length > MAX_FILES) {
    throw new McpFileError(`At most ${MAX_FILES} files per call.`);
  }

  const linked = await ensureLinkedRepository(input.documentId, {
    requireClean: false,
    runnerUserId: input.userId ?? null
  });
  if (!linked) {
    throw new McpFileError("Document not found or its workspace is unavailable.");
  }

  const paths: string[] = [];
  const commit = await withWorkspaceLock(linked.workspace, async () => {
    for (const file of input.files) {
      const { absolute, relative } = resolveWorkspaceFilePath(linked.workspace, file.path);
      const bytes = decodeFile(file);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, bytes);
      paths.push(relative);
    }
    return commitWorkspaceChanges({
      workspace: linked.workspace,
      repoUrl: linked.url,
      message: input.message,
      push: true
    });
  });

  return { linked, commitSha: commit.commitSha, paths };
}
