import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import { CLAUDE_AGENT_TOOLS } from "@/lib/ai-tools";
import { db } from "@/lib/db";

export type LinkedRepository = {
  url: string | null;
  branch: string | null;
  workspace: string;
};

export type LinkedRepositoryWorktree = LinkedRepository & {
  baseWorkspace: string;
  worktree: string;
  branchName: string;
};

type GitResult = {
  stdout: string;
  stderr: string;
};

export type CommitResult = {
  commitSha: string | null;
  commitUrl: string | null;
  pushed: boolean;
};

const WORKSPACE_ROOT = path.join(process.cwd(), ".research-workspaces");
const MAX_OVERVIEW_FILES = 240;

function buildGitEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Strip VS Code's askpass plumbing so background git doesn't try (and fail
  // with ECONNREFUSED) on a dead IPC socket inherited from the launching shell.
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  delete env.VSCODE_GIT_ASKPASS_NODE;
  delete env.VSCODE_GIT_ASKPASS_EXTRA_ARGS;
  delete env.VSCODE_GIT_ASKPASS_MAIN;
  delete env.VSCODE_GIT_IPC_HANDLE;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function buildGitArgs(args: string[]) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return args;
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  return ["-c", `http.https://github.com/.extraheader=${header}`, ...args];
}

export function isReadOnlyRepoUrl(repoUrl: string | null | undefined) {
  if (!repoUrl) return false;
  return /^https:\/\/huggingface\.co\//.test(repoUrl);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<GitResult> {
  const isGit = command === "git";
  const finalArgs = isGit ? buildGitArgs(args) : args;
  const env = isGit ? buildGitEnv() : process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(command, finalArgs, {
      cwd: options.cwd ?? process.cwd(),
      env
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} ${args.join(" ")} timed out.`));
    }, options.timeoutMs ?? 120_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr || stdout || `${command} exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function getRepoName(repoUrl: string) {
  const withoutSuffix = repoUrl.replace(/\/$/, "").replace(/\.git$/, "");
  const lastPart = withoutSuffix.split("/").pop()?.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return lastPart || "repo";
}

function slugifyBranchPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "run";
}

export function getWorkspacePath(documentId: string, repoUrl: string | null) {
  return path.join(WORKSPACE_ROOT, documentId, repoUrl ? getRepoName(repoUrl) : "local");
}

function getWorktreePath(documentId: string, repoUrl: string | null, runId: string) {
  const repoName = repoUrl ? getRepoName(repoUrl) : "local";
  return path.join(WORKSPACE_ROOT, documentId, "worktrees", `${slugifyBranchPart(runId)}-${repoName}`);
}

async function initLocalWorkspace(workspace: string) {
  await fs.mkdir(workspace, { recursive: true });
  await runCommand("git", ["init", "--initial-branch=main"], { cwd: workspace });
  // git needs an identity to commit; set local config so we don't depend on global config.
  await runCommand("git", ["config", "user.email", "ai-agent@r-docs.local"], { cwd: workspace });
  await runCommand("git", ["config", "user.name", "r-docs"], { cwd: workspace });
  // Keep agent scratch dirs out of the linked repo. If an agent ever creates one,
  // a dirty .claude/worktrees gitlink would otherwise block every future merge.
  await fs.writeFile(path.join(workspace, ".gitignore"), ".claude/\n");
  await runCommand("git", ["add", ".gitignore"], { cwd: workspace });
  await runCommand("git", ["commit", "-m", "initial"], { cwd: workspace });
}

async function hasOriginRemote(workspace: string) {
  try {
    const result = await runCommand("git", ["remote"], { cwd: workspace });
    return result.stdout.split("\n").map((s) => s.trim()).includes("origin");
  } catch {
    return false;
  }
}

export function getGithubCommitUrl(repoUrl: string | null | undefined, commitSha: string | null) {
  if (!repoUrl || !commitSha) {
    return null;
  }

  const httpsMatch = repoUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/);
  const sshMatch = repoUrl.match(/^git@github\.com:([^/]+\/[^/.]+)(?:\.git)?$/);
  const repoPath = httpsMatch?.[1] ?? sshMatch?.[1];
  return repoPath ? `https://github.com/${repoPath}/commit/${commitSha}` : null;
}

export async function ensureLinkedRepository(
  documentId: string,
  options: { requireClean?: boolean; pushPendingChanges?: boolean } = {}
): Promise<LinkedRepository | null> {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      repoUrl: true,
      repoBranch: true,
      repoWorkspace: true
    }
  });

  if (!document) {
    return null;
  }

  const workspace = document.repoWorkspace || getWorkspacePath(document.id, document.repoUrl);
  const gitDir = path.join(workspace, ".git");
  const hasCheckout = await fs
    .stat(gitDir)
    .then((stat) => stat.isDirectory())
    .catch(() => false);

  await fs.mkdir(path.dirname(workspace), { recursive: true });

  if (!hasCheckout) {
    if (document.repoUrl) {
      const cloneArgs = ["clone", document.repoUrl, workspace];
      if (document.repoBranch) {
        cloneArgs.splice(1, 0, "--branch", document.repoBranch);
      }
      await runCommand("git", cloneArgs, { timeoutMs: 300_000 });
    } else {
      await initLocalWorkspace(workspace);
    }
  }

  if (options.requireClean ?? true) {
    const status = await runCommand("git", ["status", "--porcelain"], { cwd: workspace });
    if (status.stdout.trim()) {
      await commitWorkspaceChanges({
        workspace,
        repoUrl: document.repoUrl,
        message: "Save pending AI workspace changes",
        push:
          (options.pushPendingChanges ?? true) &&
          Boolean(document.repoUrl) &&
          !isReadOnlyRepoUrl(document.repoUrl)
      });
    }
  }

  if (!document.repoWorkspace) {
    await db.document.update({
      where: { id: document.id },
      data: { repoWorkspace: workspace }
    });
  }

  return {
    url: document.repoUrl,
    branch: document.repoBranch,
    workspace
  };
}

export async function ensureLinkedRepositoryWorktree(
  documentId: string,
  runId: string
): Promise<LinkedRepositoryWorktree | null> {
  const linked = await ensureLinkedRepository(documentId, {
    requireClean: true,
    pushPendingChanges: true
  });

  if (!linked) {
    return null;
  }

  if (linked.url) {
    await runCommand("git", ["fetch", "--all", "--prune"], {
      cwd: linked.workspace,
      timeoutMs: 300_000
    }).catch(() => null);
  }

  const worktree = getWorktreePath(documentId, linked.url, runId);
  const branchName = `ai/${slugifyBranchPart(documentId)}/${slugifyBranchPart(runId)}`;
  const baseRef = linked.branch && linked.url ? `origin/${linked.branch}` : "HEAD";
  const hasWorktree = await fs
    .stat(path.join(worktree, ".git"))
    .then((stat) => stat.isFile() || stat.isDirectory())
    .catch(() => false);

  await fs.mkdir(path.dirname(worktree), { recursive: true });

  if (!hasWorktree) {
    await runCommand("git", ["worktree", "add", "-B", branchName, worktree, baseRef], {
      cwd: linked.workspace,
      timeoutMs: 300_000
    });
  }

  return {
    ...linked,
    baseWorkspace: linked.workspace,
    workspace: worktree,
    worktree,
    branchName
  };
}

// Remove a per-run worktree and its branch once the run is finished. The run's
// commit is merged into the base workspace before this is called, so the branch
// is redundant and the worktree would otherwise leak (unbounded disk growth).
// Safe to call multiple times / on a missing worktree.
export async function removeRunWorktree(worktree: {
  baseWorkspace: string;
  worktree: string;
  branchName: string;
}) {
  try {
    await runCommand("git", ["worktree", "remove", "--force", worktree.worktree], {
      cwd: worktree.baseWorkspace
    });
  } catch {
    // Worktree may already be gone; fall back to pruning + direct rm.
    await runCommand("git", ["worktree", "prune"], { cwd: worktree.baseWorkspace }).catch(() => null);
    await fs.rm(worktree.worktree, { recursive: true, force: true }).catch(() => null);
  }
  await runCommand("git", ["branch", "-D", worktree.branchName], {
    cwd: worktree.baseWorkspace
  }).catch(() => null);
}

// Best-effort sweep of orphaned worktrees left behind by crashed/killed runs.
// Prunes git's worktree metadata in every base workspace and removes worktree
// directories older than maxAgeMs. Intended to run at startup.
export async function gcStaleWorktrees(maxAgeMs = 6 * 60 * 60 * 1000) {
  let documentDirs: string[] = [];
  try {
    documentDirs = await fs.readdir(WORKSPACE_ROOT);
  } catch {
    return; // no workspaces yet
  }

  const now = Date.now();
  for (const documentId of documentDirs) {
    const worktreesDir = path.join(WORKSPACE_ROOT, documentId, "worktrees");
    let entries: string[] = [];
    try {
      entries = await fs.readdir(worktreesDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(worktreesDir, entry);
      try {
        const stat = await fs.stat(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.rm(fullPath, { recursive: true, force: true }).catch(() => null);
        }
      } catch {
        // ignore
      }
    }
    // Reconcile git's worktree list with what's left on disk.
    const baseDir = path.join(WORKSPACE_ROOT, documentId);
    let baseEntries: string[] = [];
    try {
      baseEntries = await fs.readdir(baseDir);
    } catch {
      continue;
    }
    for (const repoName of baseEntries) {
      if (repoName === "worktrees") continue;
      const candidate = path.join(baseDir, repoName);
      const hasGit = await fs
        .stat(path.join(candidate, ".git"))
        .then(() => true)
        .catch(() => false);
      if (hasGit) {
        await runCommand("git", ["worktree", "prune"], { cwd: candidate }).catch(() => null);
      }
    }
  }
}

export async function getWorkspaceOverview(workspace: string | null) {
  if (!workspace) {
    return "No repository is linked to this document.";
  }

  try {
    const result = await runCommand(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: workspace }
    );
    const files = result.stdout
      .split("\n")
      .map((file) => file.trim())
      .filter(Boolean)
      .slice(0, MAX_OVERVIEW_FILES);

    return files.length > 0
      ? files.join("\n")
      : "The linked repository has no tracked or untracked files.";
  } catch {
    return "Unable to list workspace files.";
  }
}

export function parseBuildCommand(buildCmd: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaped = false;

  for (const char of buildCmd.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped || quote) {
    return null;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens.length > 0 ? tokens : null;
}

export function validateWidgetBuildCommand(tokens: string[], cwd: string) {
  const executable = tokens[0];
  if (!executable || executable.includes("/") || executable.includes("\\")) {
    return "Widget build command must start with an executable name such as python, node, sh, bash, npm, or npx.";
  }

  const allowedExecutables = new Set(["python", "python3", "node", "sh", "bash", "npm", "npx"]);
  if (!allowedExecutables.has(executable)) {
    return `Widget build executable "${executable}" is not allowed.`;
  }

  const workspaceRoot = path.resolve(cwd);
  for (const token of tokens.slice(1)) {
    if (!token || token.startsWith("-") || /^[A-Za-z0-9_./:=,@+-]+$/.test(token)) {
      continue;
    }
    return `Widget build argument contains unsupported characters: ${token}`;
  }

  const scriptToken = tokens.find((token) => /(^|\/)widgets\/.+\.(py|js|mjs|cjs|sh)$/i.test(token));
  if (scriptToken) {
    const scriptPath = path.resolve(cwd, scriptToken);
    if (!scriptPath.startsWith(`${workspaceRoot}${path.sep}`)) {
      return "Widget build script must be inside the repository workspace.";
    }
  }

  return null;
}

export async function runWidgetBuild(buildCmd: string, cwd: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const tokens = parseBuildCommand(buildCmd);
  if (!tokens) {
    return { ok: false, error: "Widget build command could not be parsed." };
  }

  const validationError = validateWidgetBuildCommand(tokens, cwd);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  return new Promise((resolve) => {
    const [command, ...args] = tokens;
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: process.env
    });
    let stderr = "";
    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, error: "Widget build timed out after 120 seconds." });
    }, 120_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const message = (stderr || stdout || `Widget build exited with code ${code}`).trim();
        resolve({ ok: false, error: message });
        return;
      }
      resolve({ ok: true });
    });
  });
}

async function syncBranchToBaseWorkspace(baseWorkspace: string, commitSha: string, push: boolean) {
  const status = await runCommand("git", ["status", "--porcelain"], { cwd: baseWorkspace });
  if (status.stdout.trim()) {
    throw new Error(`Cannot merge AI changes into the linked repository because it has pending changes:\n${status.stdout}`);
  }

  try {
    await runCommand("git", ["merge", "--ff-only", commitSha], { cwd: baseWorkspace });
  } catch {
    try {
      await runCommand("git", ["merge", "--no-edit", commitSha], { cwd: baseWorkspace });
    } catch (mergeError) {
      await resolveMergeConflictsWithClaude(baseWorkspace, commitSha);
      const unmerged = await runCommand("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: baseWorkspace });
      if (unmerged.stdout.trim()) {
        await runCommand("git", ["merge", "--abort"], { cwd: baseWorkspace }).catch(() => null);
        throw new Error(
          `Claude could not resolve merge conflicts for ${commitSha}. Unmerged paths:\n${unmerged.stdout.trim()}`
        );
      }
      await runCommand("git", ["add", "-A"], { cwd: baseWorkspace });
      try {
        await runCommand("git", ["commit", "--no-edit"], { cwd: baseWorkspace });
      } catch (commitError) {
        await runCommand("git", ["merge", "--abort"], { cwd: baseWorkspace }).catch(() => null);
        throw commitError instanceof Error ? commitError : mergeError;
      }
    }
  }

  if (push && (await hasOriginRemote(baseWorkspace))) {
    await runCommand("git", ["push", "origin", "HEAD"], {
      cwd: baseWorkspace,
      timeoutMs: 300_000
    }).catch(() => null);
  }
}

async function resolveMergeConflictsWithClaude(baseWorkspace: string, commitSha: string) {
  const model = process.env.CLAUDE_AGENT_MODEL || "sonnet";
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 300_000);
  const prompt = `A git merge is currently in progress in this repository.

The commit being merged is ${commitSha}.

Resolve all merge conflicts in the working tree. Preserve both the base branch intent and the incoming AI agent changes whenever they are compatible. If a real semantic conflict exists, make the smallest coherent implementation that keeps the repository buildable.

Do not commit. After editing, run \`git status --porcelain\` and report whether any unmerged paths remain.

Return only JSON:
{"summary":"what you resolved","unresolved":false}
`;

  const mergeQuery = query({
    prompt,
    options: {
      cwd: baseWorkspace,
      systemPrompt:
        "You are resolving git merge conflicts for a collaborative document app. Edit files directly, remove conflict markers, and keep the result coherent. Do not run background processes and do not commit.",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: CLAUDE_AGENT_TOOLS,
      maxTurns: Number.parseInt(process.env.CLAUDE_MERGE_MAX_TURNS || "8", 10),
      model,
      thinking: { type: "disabled" },
      abortController
    }
  });

  try {
    for await (const message of mergeQuery) {
      if (message.type === "result" && message.is_error) {
        const errors = "errors" in message ? message.errors : ["Claude merge conflict resolution failed."];
        throw new Error(errors.join("\n"));
      }
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error("Claude merge conflict resolution timed out after 300 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    mergeQuery.close();
  }
}

export async function commitWorkspaceChanges(input: {
  workspace: string;
  baseWorkspace?: string;
  repoUrl: string | null;
  message: string;
  push: boolean;
}): Promise<CommitResult> {
  const status = await runCommand("git", ["status", "--porcelain"], { cwd: input.workspace });
  if (!status.stdout.trim()) {
    return {
      commitSha: null,
      commitUrl: null,
      pushed: false
    };
  }

  await runCommand("git", ["add", "-A"], { cwd: input.workspace });
  await runCommand("git", ["commit", "-m", input.message], { cwd: input.workspace });
  const shaResult = await runCommand("git", ["rev-parse", "HEAD"], { cwd: input.workspace });
  const commitSha = shaResult.stdout.trim();

  let pushed = false;
  if (input.push && !isReadOnlyRepoUrl(input.repoUrl) && (await hasOriginRemote(input.workspace))) {
    await runCommand("git", ["push", "-u", "origin", "HEAD"], {
      cwd: input.workspace,
      timeoutMs: 300_000
    });
    pushed = true;
  }

  if (
    commitSha &&
    input.baseWorkspace &&
    path.resolve(input.baseWorkspace) !== path.resolve(input.workspace)
  ) {
    await syncBranchToBaseWorkspace(
      input.baseWorkspace,
      commitSha,
      input.push && !isReadOnlyRepoUrl(input.repoUrl)
    );
  }

  return {
    commitSha,
    commitUrl: getGithubCommitUrl(input.repoUrl, commitSha),
    pushed
  };
}
