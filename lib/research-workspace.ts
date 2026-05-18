import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { db } from "@/lib/db";

export type LinkedRepository = {
  url: string;
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

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    const timeout = windowlessTimeout(() => {
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

function windowlessTimeout(callback: () => void, ms: number) {
  return setTimeout(callback, ms);
}

function getRepoName(repoUrl: string) {
  const withoutSuffix = repoUrl.replace(/\/$/, "").replace(/\.git$/, "");
  const lastPart = withoutSuffix.split("/").pop()?.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return lastPart || "repo";
}

function slugifyBranchPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "run";
}

export function getWorkspacePath(documentId: string, repoUrl: string) {
  return path.join(WORKSPACE_ROOT, documentId, getRepoName(repoUrl));
}

function getWorktreePath(documentId: string, repoUrl: string, runId: string) {
  return path.join(WORKSPACE_ROOT, documentId, "worktrees", `${slugifyBranchPart(runId)}-${getRepoName(repoUrl)}`);
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

  if (!document?.repoUrl) {
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
    const cloneArgs = ["clone", document.repoUrl, workspace];
    if (document.repoBranch) {
      cloneArgs.splice(1, 0, "--branch", document.repoBranch);
    }
    await runCommand("git", cloneArgs, { timeoutMs: 300_000 });
  }

  if (options.requireClean ?? true) {
    const status = await runCommand("git", ["status", "--porcelain"], { cwd: workspace });
    if (status.stdout.trim()) {
      await commitWorkspaceChanges({
        workspace,
        repoUrl: document.repoUrl,
        message: "Save pending AI workspace changes",
        push: options.pushPendingChanges ?? true
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

  await runCommand("git", ["fetch", "--all", "--prune"], {
    cwd: linked.workspace,
    timeoutMs: 300_000
  }).catch(() => null);

  const worktree = getWorktreePath(documentId, linked.url, runId);
  const branchName = `ai/${slugifyBranchPart(documentId)}/${slugifyBranchPart(runId)}`;
  const baseRef = linked.branch ? `origin/${linked.branch}` : "HEAD";
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

export async function commitWorkspaceChanges(input: {
  workspace: string;
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
  if (input.push) {
    await runCommand("git", ["push", "-u", "origin", "HEAD"], {
      cwd: input.workspace,
      timeoutMs: 300_000
    });
    pushed = true;
  }

  return {
    commitSha,
    commitUrl: getGithubCommitUrl(input.repoUrl, commitSha),
    pushed
  };
}
