// End-of-run merge-back must use the RUN's credentials, and a merge failure
// after a successful submission must not fail the run.
//
// 2026-10-06 incident (runs cmuwfeim5008px7rovazkixsx, cmuwfel7r009xx7roprbzsyi0,
// API-channel runs): the agents committed files to the base workspace mid-run
// through the MCP bridge (upload_files), then changed the same paths in their
// worktree, so merging the run commit back conflicted. The conflict resolver was
// spawned with NO agentConfig/agentEnv (resolveMergeConflictsWithClaude passed
// only { workspacePath, commitSha }), the container runner found no Anthropic
// credential and threw "[agent-runner] Connect an Anthropic credential in
// settings to run this model.", and the lifecycle marked the already-succeeded
// run FAILED.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

process.env.CREDENTIAL_ENCRYPTION_KEY ??= crypto.randomBytes(32).toString("base64");
// The broker is opt-in per test below; a deploy shell may have it set from .env.
delete process.env.AGENT_CREDENTIAL_BROKER;

import { withAgentRunLifecycle } from "../lib/agent-run-lifecycle";
import { setAgentRunnerForTesting, type AgentRunner, type MergeResolveJob } from "../lib/agent-runner";
import { DurableContainerRunner } from "../lib/agent-runner/durable";
import { resolveBrokerRequest } from "../lib/credential-broker";
import { db } from "../lib/db";
import { upsertDocumentEnv } from "../lib/document-env";
import { commitWorkspaceChanges } from "../lib/research-workspace";

const WORKSPACE_ROOT = path.join(process.cwd(), ".research-workspaces");
const RUN_KEY = "sk-ant-api03-run-credential-for-merge";
const CONNECT_MESSAGE = "[agent-runner] Connect an Anthropic credential in settings to run this model.";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// Mirrors ContainerRunner: a resolver job without an Anthropic credential
// throws exactly what production threw. With one, it resolves the conflict by
// taking the incoming version (what the merge agent would do) and stages it.
function fakeRunner(behaviour: "resolve" | "throw", seen: MergeResolveJob[], onJob?: (job: MergeResolveJob) => Promise<void>): AgentRunner {
  return {
    mode: "inprocess",
    run: async () => {
      throw new Error("not used");
    },
    resolveMergeConflicts: async (job) => {
      seen.push(job);
      await onJob?.(job);
      const env = job.agentEnv ?? {};
      if (!env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error(CONNECT_MESSAGE);
      if (behaviour === "throw") throw new Error("merge agent timed out");
      git(job.workspacePath, "checkout", "--theirs", "--", "report.md");
      git(job.workspacePath, "add", "--", "report.md");
    }
  };
}

async function fixture() {
  const user = await db.user.create({
    data: { email: `merge-cred-${crypto.randomUUID()}@example.com`, name: "merge", passwordHash: "x" }
  });
  const document = await db.document.create({
    data: { title: "Merge credentials", content: "{}", ownerId: user.id }
  });
  await upsertDocumentEnv(document.id, "ANTHROPIC_API_KEY", RUN_KEY);
  const run = await db.aiRun.create({
    data: {
      documentId: document.id,
      createdById: user.id,
      triggerType: "API_CHANNEL",
      instruction: "write report.md",
      status: "RUNNING",
      startedAt: new Date(),
      heartbeatAt: new Date()
    }
  });
  return { user, document, run };
}

async function cleanup(documentId: string, userId: string) {
  await db.aiRun.updateMany({ where: { documentId }, data: { status: "FAILED" } });
  await fs.rm(path.join(WORKSPACE_ROOT, documentId), { recursive: true, force: true }).catch(() => null);
  await db.document.delete({ where: { id: documentId } }).catch(() => null);
  await db.user.delete({ where: { id: userId } }).catch(() => null);
}

// The incident's shape: the base workspace gets report.md mid-run (upload_files
// over the MCP bridge commits straight into the base), and the run's worktree
// writes a different report.md — so the end-of-run merge conflicts.
async function runWithConflictingMerge(documentId: string, userId: string, aiRunId: string) {
  return withAgentRunLifecycle(
    {
      aiRunId,
      documentId,
      createdById: userId,
      agentAccessMode: "workspace",
      runnerMode: "managed",
      failureCommitMessage: "wip",
      defaultFailureMessage: "run failed"
    },
    async (ctx) => {
      const linked = await ctx.setupWorkspace();
      assert.ok(linked, "managed run gets an isolated worktree");
      await ctx.loadEnv({ model: "claude-sonnet-5", effort: null });

      await fs.writeFile(path.join(linked.baseWorkspace, "report.md"), "uploaded mid-run via MCP\n");
      await commitWorkspaceChanges({
        workspace: linked.baseWorkspace,
        repoUrl: null,
        message: "upload_files: report.md",
        push: false
      });
      await fs.writeFile(path.join(linked.worktree, "report.md"), "final report from the run\n");

      const commit = await ctx.commitRunChanges("AI research conversation changes");
      return { commit, baseWorkspace: linked.baseWorkspace };
    }
  );
}

test("the end-of-run merge resolver gets the run's agentConfig and agentEnv", async () => {
  const { user, document, run } = await fixture();
  const seen: MergeResolveJob[] = [];
  setAgentRunnerForTesting(fakeRunner("resolve", seen));
  try {
    const result = await runWithConflictingMerge(document.id, user.id, run.id);
    assert.equal(seen.length, 1, "the conflict reached the resolver");
    assert.equal(seen[0].agentEnv?.ANTHROPIC_API_KEY, RUN_KEY, "resolver must get the run's credential");
    assert.equal(seen[0].agentConfig?.model, "claude-sonnet-5");
    assert.equal(result.status, "SUCCEEDED", JSON.stringify(result));
    if (result.status !== "SUCCEEDED") return;
    const { commit, baseWorkspace } = result.value;
    assert.ok(commit.commitSha);
    assert.equal(commit.mergeError, undefined);
    assert.equal(
      await fs.readFile(path.join(baseWorkspace, "report.md"), "utf8"),
      "final report from the run\n",
      "the resolved merge landed in the base"
    );
    assert.equal(git(baseWorkspace, "status", "--porcelain"), "");
  } finally {
    setAgentRunnerForTesting(null);
    await cleanup(document.id, user.id);
  }
});

test("a failed merge-back keeps the run SUCCEEDED, preserves the commit and records a visible warning", async () => {
  const { user, document, run } = await fixture();
  const seen: MergeResolveJob[] = [];
  setAgentRunnerForTesting(fakeRunner("throw", seen));
  try {
    const result = await runWithConflictingMerge(document.id, user.id, run.id);
    assert.equal(result.status, "SUCCEEDED", JSON.stringify(result));
    if (result.status !== "SUCCEEDED") return;
    const { commit, baseWorkspace } = result.value;
    assert.ok(commit.commitSha);
    assert.match(commit.mergeError ?? "", /merge agent timed out/);
    assert.ok(commit.preservedRef, "the unmerged commit is kept under a ref");
    assert.equal(git(baseWorkspace, "rev-parse", commit.preservedRef!), commit.commitSha);
    assert.equal(git(baseWorkspace, "status", "--porcelain"), "", "base is not left mid-merge");
    assert.equal(
      await fs.readFile(path.join(baseWorkspace, "report.md"), "utf8"),
      "uploaded mid-run via MCP\n",
      "base keeps its own version"
    );

    const fresh = await db.aiRun.findUnique({ where: { id: run.id }, select: { status: true, error: true } });
    assert.equal(fresh?.status, "RUNNING", "lifecycle did not fail the run");
    assert.equal(fresh?.error, null);
    const events = await db.aiRunEvent.findMany({ where: { aiRunId: run.id }, select: { role: true, message: true } });
    const warning = events.find((event) => /could not be merged/i.test(event.message));
    assert.ok(warning, JSON.stringify(events));
    assert.ok(warning.message.includes(commit.preservedRef!), "the warning names where the work is");
  } finally {
    setAgentRunnerForTesting(null);
    await cleanup(document.id, user.id);
  }
});

test("with the credential broker on, the resolver's virtual key is still live during merge-back", async () => {
  process.env.AGENT_CREDENTIAL_BROKER = "1";
  const { user, document, run } = await fixture();
  const seen: MergeResolveJob[] = [];
  const resolutions: Array<{ ok: boolean; error?: string }> = [];
  setAgentRunnerForTesting(
    fakeRunner("resolve", seen, async (job) => {
      const token = job.agentEnv?.ANTHROPIC_API_KEY ?? null;
      const key = await db.agentBrokerKey.findFirst({ where: { aiRunId: run.id, provider: "anthropic" } });
      assert.ok(key, "the run minted an anthropic broker key");
      const resolution = await resolveBrokerRequest(key.id, token);
      resolutions.push(resolution.ok ? { ok: true } : { ok: false, error: resolution.error });
    })
  );
  try {
    const result = await runWithConflictingMerge(document.id, user.id, run.id);
    assert.equal(result.status, "SUCCEEDED", JSON.stringify(result));
    assert.equal(seen.length, 1);
    assert.notEqual(seen[0].agentEnv?.ANTHROPIC_API_KEY, RUN_KEY, "the real key never reaches the resolver");
    assert.deepEqual(resolutions, [{ ok: true }]);
  } finally {
    delete process.env.AGENT_CREDENTIAL_BROKER;
    setAgentRunnerForTesting(null);
    await db.agentBrokerKey.deleteMany({ where: { aiRunId: run.id } }).catch(() => null);
    await cleanup(document.id, user.id);
  }
});

test("the durable runner forwards the merge job's credentials unchanged", async () => {
  const seen: MergeResolveJob[] = [];
  setAgentRunnerForTesting(fakeRunner("resolve", seen, async () => {
    throw new Error("stop after recording");
  }));
  try {
    const durable = new DurableContainerRunner({
      workspaceDocumentId: "doc",
      containerName: "rdocs-durable-test",
      hostname: null,
      appPort: 3000,
      sessionsRootHostPath: "/tmp/none"
    } as ConstructorParameters<typeof DurableContainerRunner>[0]);
    const job: MergeResolveJob = {
      workspacePath: "/tmp/base",
      commitSha: "abc",
      agentConfig: { model: "claude-sonnet-5" },
      agentEnv: { ANTHROPIC_API_KEY: RUN_KEY }
    };
    await assert.rejects(durable.resolveMergeConflicts(job), /stop after recording/);
    assert.deepEqual(seen, [job]);
  } finally {
    setAgentRunnerForTesting(null);
  }
});
