import path from "node:path";

// Defense-in-depth workspace confinement for the research agent. The kernel
// Seatbelt sandbox (configured in lib/ai.ts) is the real boundary; this is a
// deterministic, unit-testable PreToolUse guard layered on top:
//   - structured file tools (Read/Write/Edit/Grep/Glob/LS) must target a path
//     inside the document's workspace — clean and non-leaky for those tools.
//   - Bash commands may not reference an absolute path inside a "protected root"
//     (e.g. the gdocs-ai server repo, where app code + other docs' worktrees
//     live) unless it's inside this workspace.

export const FILE_PATH_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "Grep", "Glob", "LS"]);

function resolveAgainst(workspace: string, candidate: string): string {
  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(workspace, candidate);
}

export function isPathWithinWorkspace(workspace: string, candidate: string): boolean {
  const root = path.resolve(workspace);
  const resolved = resolveAgainst(root, candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function isWithin(root: string, candidate: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  return c === r || c.startsWith(r + path.sep);
}

// Pull absolute-path-looking tokens out of a shell command. Best-effort: handles
// space/quote separation and a leading `~` (home). Heuristic by design — the
// Seatbelt sandbox is the authoritative boundary.
export function extractAbsolutePaths(command: string): string[] {
  const tokens = command.split(/[\s'"=:;|&()<>]+/).filter(Boolean);
  return tokens.filter((token) => token.startsWith("/") || token.startsWith("~/"));
}

export type ToolAccessDecision = { allowed: true } | { allowed: false; reason: string; blockedPath: string };

export function evaluateToolPathAccess(input: {
  workspace: string;
  protectedRoots: string[];
  toolName: string;
  toolInput: Record<string, unknown> | null | undefined;
}): ToolAccessDecision {
  const { workspace, protectedRoots, toolName, toolInput } = input;
  if (!toolInput || typeof toolInput !== "object") return { allowed: true };

  if (FILE_PATH_TOOLS.has(toolName)) {
    const candidate = toolInput.file_path ?? toolInput.path;
    if (typeof candidate === "string" && candidate.length > 0) {
      if (!isPathWithinWorkspace(workspace, candidate)) {
        return {
          allowed: false,
          blockedPath: candidate,
          reason: `${toolName} is confined to the document workspace; "${candidate}" is outside it.`
        };
      }
    }
    return { allowed: true };
  }

  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    const home = process.env.HOME ?? "";
    for (const token of extractAbsolutePaths(command)) {
      const abs = token.startsWith("~/") && home ? path.join(home, token.slice(2)) : token;
      if (isPathWithinWorkspace(workspace, abs)) continue;
      for (const root of protectedRoots) {
        if (isWithin(root, abs)) {
          return {
            allowed: false,
            blockedPath: abs,
            reason: `Bash may not access "${abs}" — it is outside the document workspace and inside a protected directory.`
          };
        }
      }
    }
  }

  return { allowed: true };
}
