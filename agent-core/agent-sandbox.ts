import path from "node:path";

// Workspace confinement for the research agent. Under `bypassPermissions` the
// kernel Seatbelt sandbox does NOT restrict filesystem *reads* (its read rules
// are permission-driven), so this deterministic, unit-testable PreToolUse guard
// is the effective boundary — not merely defense-in-depth.
//   - structured file tools (Read/Write/Edit/Grep/Glob/LS) must target a path
//     inside the document's workspace.
//   - Bash commands are confined the same way: an absolute path (or a `~` /
//     `$HOME` reference) is allowed only if it is inside the workspace or inside
//     a curated allowlist of system/toolchain roots. Everything else — crucially
//     the host home directory, sibling documents' worktrees, and the server repo
//     — is denied. (A denylist of "protected roots" used to miss the home dir,
//     which is the *parent* of the server repo, so `ls ~` leaked the host home.)

export const FILE_PATH_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "Grep", "Glob", "LS"]);

// System/toolchain roots an agent legitimately needs to read or execute from.
// Deliberately excludes user-home roots (/Users, /home, /root) so personal data
// (SSH keys, cloud creds, other projects) stays out of reach. The workspace
// itself is always allowed regardless of this list.
export const DEFAULT_SYSTEM_PATH_ALLOWLIST = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/opt",
  "/etc",
  "/var",
  "/tmp",
  "/private",
  "/dev",
  "/proc",
  "/sys",
  "/run",
  "/nix",
  "/snap",
  "/System",
  "/Library",
  "/Applications"
];

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
  return tokens.filter(
    (token) => token.startsWith("/") || token.startsWith("~/") || token === "~"
  );
}

export type ToolAccessDecision = { allowed: true } | { allowed: false; reason: string; blockedPath: string };

export function evaluateToolPathAccess(input: {
  workspace: string;
  protectedRoots: string[];
  toolName: string;
  toolInput: Record<string, unknown> | null | undefined;
  systemPathAllowlist?: string[];
}): ToolAccessDecision {
  const { workspace, protectedRoots, toolName, toolInput } = input;
  const systemPathAllowlist = input.systemPathAllowlist ?? DEFAULT_SYSTEM_PATH_ALLOWLIST;
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
    const rawCommand = typeof toolInput.command === "string" ? toolInput.command : "";
    const home = process.env.HOME ?? "";
    // Expand $HOME / ${HOME} up front so they can't smuggle a home-directory
    // path past the `~` handling below.
    const command = home
      ? rawCommand.replace(/\$\{HOME\}/g, home).replace(/\$HOME(?![A-Za-z0-9_])/g, home)
      : rawCommand;
    for (const token of extractAbsolutePaths(command)) {
      // `~` and `~/…` both resolve under $HOME; slice(1) keeps the leading
      // slash for the `~/…` case and yields "" (→ home) for a bare `~`.
      const abs = (token === "~" || token.startsWith("~/")) && home
        ? path.join(home, token.slice(1))
        : token;
      if (isPathWithinWorkspace(workspace, abs)) continue;
      if (systemPathAllowlist.some((root) => isWithin(root, abs))) continue;
      const protectedHit = protectedRoots.find((root) => isWithin(root, abs));
      return {
        allowed: false,
        blockedPath: abs,
        reason: protectedHit
          ? `Bash may not access "${abs}" — it is inside a protected directory (${protectedHit}) outside the document workspace.`
          : `Bash is confined to the document workspace; "${abs}" is outside it and is not an allowed system path.`
      };
    }
  }

  return { allowed: true };
}
