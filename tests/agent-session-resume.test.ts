import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { db } from "../lib/db";
import {
  findResumableSessionId,
  codexSessionExists,
  getConversationSessionDir,
  planSessionResume,
  resolveConversationRootId,
  sessionTranscriptExists,
  withConversationLock
} from "../lib/agent-sessions";
import { buildUserPrompt } from "../agent-core/agent";
import { buildContainerEnv, buildContainerRunArgs } from "../lib/agent-runner/container-args";

async function makeDocument() {
  const user = await db.user.create({
    data: { email: `sess-${crypto.randomUUID()}@example.com`, name: "sess", passwordHash: "x" }
  });
  const document = await db.document.create({
    data: { ownerId: user.id, title: "Session doc", content: "{}" }
  });
  return document;
}

async function makeRun(
  documentId: string,
  overrides: { parentRunId?: string | null; sdkSessionId?: string | null; status?: string } = {}
) {
  return db.aiRun.create({
    data: {
      documentId,
      triggerType: "CONVERSATION",
      instruction: "test",
      status: overrides.status ?? "SUCCEEDED",
      parentRunId: overrides.parentRunId ?? null,
      sdkSessionId: overrides.sdkSessionId ?? null
    }
  });
}

async function writeTranscript(sessionDir: string, sessionId: string) {
  const projectDir = path.join(sessionDir, "projects", "-workspace");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, `${sessionId}.jsonl`), '{"type":"user"}\n');
}

test("conversation root id: walks the whole follow-up chain, cycle-safe", async () => {
  const doc = await makeDocument();
  const root = await makeRun(doc.id);
  let prev = root;
  for (let i = 0; i < 30; i++) {
    prev = await makeRun(doc.id, { parentRunId: prev.id });
  }
  // 31 runs deep — beyond the 24-turn replay cap that used to re-key sessions.
  assert.equal(await resolveConversationRootId(doc.id, prev.id), root.id);
  assert.equal(await resolveConversationRootId(doc.id, root.id), root.id);
  assert.equal(await resolveConversationRootId(doc.id, null), null);
  // A previous run from ANOTHER document never yields a root.
  const otherDoc = await makeDocument();
  assert.equal(await resolveConversationRootId(otherDoc.id, prev.id), null);
});

test("findResumableSessionId walks past runs that died before SDK init", async () => {
  const doc = await makeDocument();
  const root = await makeRun(doc.id, { sdkSessionId: "sess-root" });
  const crashed = await makeRun(doc.id, { parentRunId: root.id, status: "FAILED" });
  assert.equal(await findResumableSessionId(doc.id, crashed.id), "sess-root");
  const withOwn = await makeRun(doc.id, { parentRunId: crashed.id, sdkSessionId: "sess-own" });
  assert.equal(await findResumableSessionId(doc.id, withOwn.id), "sess-own");
  assert.equal(await findResumableSessionId(doc.id, null), null);
});

test("planSessionResume resumes only when the transcript actually exists on disk", async () => {
  const doc = await makeDocument();
  const sessionId = crypto.randomUUID();
  const root = await makeRun(doc.id, { sdkSessionId: sessionId });
  const followUp = await makeRun(doc.id, { parentRunId: root.id, status: "RUNNING" });

  // No transcript yet (pre-feature run / GC'd dir) → fall back to replay.
  const withoutFile = await planSessionResume({
    documentId: doc.id,
    aiRunId: followUp.id,
    previousRunId: root.id,
    runnerMode: "container"
  });
  assert.equal(withoutFile.conversationKey, root.id, "conversation is keyed by the root run");
  assert.equal(withoutFile.resumeSessionId, null, "missing transcript must not be resumed");
  assert.equal(
    withoutFile.resumeUnavailableSessionId,
    sessionId,
    "a recorded-but-unresumable session must be reported so the context downgrade is not silent"
  );

  // With the transcript in the conversation's session dir → resume.
  await writeTranscript(withoutFile.sessionDir, sessionId);
  const withFile = await planSessionResume({
    documentId: doc.id,
    aiRunId: followUp.id,
    previousRunId: root.id,
    runnerMode: "container"
  });
  assert.equal(withFile.resumeSessionId, sessionId);
  assert.equal(withFile.resumeUnavailableSessionId, null, "a resumable session is not a downgrade");
  assert.equal(withFile.sessionDir, getConversationSessionDir(doc.id, root.id));
  // The dir is created so the container mount always has a target.
  assert.ok((await fs.stat(withFile.sessionDir)).isDirectory());

  // A fresh conversation (no previous run) never resumes; keyed by its own id.
  const fresh = await makeRun(doc.id, { status: "RUNNING" });
  const freshPlan = await planSessionResume({
    documentId: doc.id,
    aiRunId: fresh.id,
    previousRunId: null,
    runnerMode: "container"
  });
  assert.equal(freshPlan.resumeSessionId, null);
  assert.equal(
    freshPlan.resumeUnavailableSessionId,
    null,
    "a fresh conversation has no prior context to lose"
  );
  assert.equal(freshPlan.conversationKey, fresh.id);

  await fs.rm(path.dirname(withFile.sessionDir), { recursive: true, force: true });
});

test("in-process runs resume from the conversation session dir, not the host config dir", async () => {
  // The in-process runner hands that dir to agent-core as CLAUDE_CONFIG_DIR;
  // the host's ~/.claude is never the CLI's config root (it would double as a
  // host-credential source — see tests/agent-config-dir.test.ts).
  const doc = await makeDocument();
  const sessionId = crypto.randomUUID();
  const root = await makeRun(doc.id, { sdkSessionId: sessionId });
  const followUp = await makeRun(doc.id, { parentRunId: root.id, status: "RUNNING" });

  const missing = await planSessionResume({
    documentId: doc.id,
    aiRunId: followUp.id,
    previousRunId: root.id,
    runnerMode: "inprocess"
  });
  assert.equal(missing.resumeSessionId, null, "no transcript in the session dir yet");
  assert.equal(missing.resumeUnavailableSessionId, sessionId);

  await writeTranscript(missing.sessionDir, sessionId);
  const plan = await planSessionResume({
    documentId: doc.id,
    aiRunId: followUp.id,
    previousRunId: root.id,
    runnerMode: "inprocess"
  });
  assert.equal(plan.resumeSessionId, sessionId);
  await fs.rm(path.dirname(plan.sessionDir), { recursive: true, force: true });
});

test("sessionTranscriptExists: empty files and missing dirs don't count", async () => {
  const dir = path.join(process.cwd(), ".research-workspaces", `test-tx-${crypto.randomUUID()}`);
  assert.equal(await sessionTranscriptExists(dir, "nope"), false);
  const projectDir = path.join(dir, "projects", "-workspace");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "empty.jsonl"), "");
  assert.equal(await sessionTranscriptExists(dir, "empty"), false, "empty transcript is not resumable");
  await fs.writeFile(path.join(projectDir, "full.jsonl"), '{"type":"user"}\n');
  assert.equal(await sessionTranscriptExists(dir, "full"), true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("Codex resume uses its native rollout file and stores only the opaque thread id in the DB", async () => {
  const doc = await makeDocument();
  const sessionId = crypto.randomUUID();
  const root = await makeRun(doc.id, { sdkSessionId: sessionId });
  const followUp = await makeRun(doc.id, { parentRunId: root.id, status: "RUNNING" });
  const sessionDir = getConversationSessionDir(doc.id, root.id);
  const nativeDir = path.join(sessionDir, "sessions", "2026", "08", "04");
  await fs.mkdir(nativeDir, { recursive: true });
  await fs.writeFile(path.join(nativeDir, `rollout-2026-08-04T12-00-00-${sessionId}.jsonl`), '{"native":"codex"}\n');

  assert.equal(await codexSessionExists(sessionDir, sessionId), true);
  const plan = await planSessionResume({
    documentId: doc.id,
    aiRunId: followUp.id,
    previousRunId: root.id,
    runnerMode: "container",
    agentModel: "codex/openai/gpt-5.6-terra"
  });
  assert.equal(plan.resumeSessionId, sessionId);
  await fs.rm(path.dirname(sessionDir), { recursive: true, force: true });
});

test("withConversationLock serializes tasks on the same key", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
  const first = withConversationLock("conv-1", async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
  });
  const second = withConversationLock("conv-1", async () => {
    order.push("second");
  });
  // An unrelated key is NOT blocked.
  await withConversationLock("conv-2", async () => {
    order.push("other-key");
  });
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "other-key", "first-end", "second"]);
});

test("resumed conversation prompt: resume note replaces the transcript replay", () => {
  const base = {
    mode: "conversation" as const,
    documentTitle: "Doc",
    documentText: "",
    unresolvedThreads: [],
    workspacePath: "/tmp/w",
    workspaceOverview: "",
    instruction: "and now expand it"
  };
  const resumed = buildUserPrompt({ ...base, resumeSessionId: "abc-123" });
  assert.match(resumed, /continues your earlier session/);
  assert.match(resumed, /workspace was recreated fresh/);
  assert.doesNotMatch(resumed, /Earlier in this conversation:/);

  const replayed = buildUserPrompt({
    ...base,
    conversationHistory: [
      { role: "user", message: "start" },
      { role: "agent", message: "done" }
    ]
  });
  assert.match(replayed, /Earlier in this conversation:/);
  assert.doesNotMatch(replayed, /continues your earlier session/);
});

test("container args: session dir is mounted rw and exported as CLAUDE_CONFIG_DIR", () => {
  const spec = {
    image: "gdocs-agent:local",
    workspaceHostPath: "/repo/.research-workspaces/doc-1/worktrees/run-1",
    envFileHostPath: "/tmp/env",
    uid: 501,
    gid: 20
  };
  const without = buildContainerRunArgs(spec);
  assert.ok(!without.join(" ").includes("CLAUDE_CONFIG_DIR"), "no session env without a session dir");
  assert.equal(without.filter((_, i) => without[i - 1] === "-v").length, 1);

  const sessionHost = "/repo/.research-workspaces/doc-1/sessions/run-root";
  const withSession = buildContainerRunArgs({ ...spec, sessionDirHostPath: sessionHost });
  const mounts = withSession.filter((_, i) => withSession[i - 1] === "-v");
  assert.deepEqual(mounts, [
    "/repo/.research-workspaces/doc-1/worktrees/run-1:/workspace",
    `${sessionHost}:/agent-sessions`
  ]);
  assert.ok(withSession.join(" ").includes("-e CLAUDE_CONFIG_DIR=/agent-sessions"));
  // Mount + env must precede the image argument.
  assert.equal(withSession[withSession.length - 1], "gdocs-agent:local");
});

test("a host CLAUDE_CONFIG_DIR never leaks into the container env", () => {
  const env = buildContainerEnv(
    { CLAUDE_CONFIG_DIR: "/Users/host/.claude", ANTHROPIC_API_KEY: "sk-1" },
    {}
  );
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "host credentials must not leak either");
});
