import fs from "node:fs/promises";
import path from "node:path";

// Resolve a widget's embed_source HTML from one or more candidate workspaces.
// Extracted from the widget source route so the path logic is unit-testable —
// "widgets would not appear because of false paths of saved assets" was a real
// bug class. The candidate order matters: the base checkout is tried first
// (after a run merges, the asset lives there and the per-run worktree may have
// been garbage-collected), then the run's recorded workspacePath as a fallback.

export async function tryReadEmbedSource(workspace: string, embedSource: string): Promise<string | null> {
  const sourcePath = path.resolve(workspace, embedSource);
  const workspaceRoot = path.resolve(workspace);
  // Containment guard: never read outside the workspace (rejects ../ traversal).
  if (!sourcePath.startsWith(`${workspaceRoot}${path.sep}`)) {
    return null;
  }
  try {
    return await fs.readFile(sourcePath, "utf8");
  } catch {
    return null;
  }
}

export async function readEmbedSourceFromCandidates(
  candidates: Array<string | null | undefined>,
  embedSource: string
): Promise<string | null> {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const html = await tryReadEmbedSource(candidate, embedSource);
    if (html !== null) {
      return html;
    }
  }
  return null;
}
