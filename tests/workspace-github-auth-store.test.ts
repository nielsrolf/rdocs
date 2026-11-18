import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-auth-store-"));
process.env.RDOCS_GIT_AUTH_DIR = storeDir;

import { db } from "../lib/db";
import { recordAiRunEvent } from "../lib/ai-runs";
import {
  forgetWorkspaceGithubToken,
  hardenAgentGitDir,
  readWorkspaceGithubToken,
  stripWorkspaceGithubAuth
} from "../lib/research-workspace";
import { rememberRunSecrets } from "../lib/secret-redaction";

const TOKEN = `ghp_${"Z9y8X7w6V5u4T3s2R1q0".repeat(2).slice(0, 36)}`;
const dirs = [storeDir];
const created = { users: [] as string[], documents: [] as string[] };

test.after(async () => {
  await db.document.deleteMany({ where: { id: { in: created.documents } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
  await db.$disconnect();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function everyFileUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? everyFileUnder(full) : [full];
  });
}

test("a checkout from before the change loses its pinned token; the host keeps it, encrypted, elsewhere", async () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-checkout-"));
  dirs.push(checkout);
  execFileSync("git", ["init", "--initial-branch=main", checkout], { stdio: "ignore" });
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
  execFileSync("git", ["-C", checkout, "config", "http.https://github.com/.extraheader", header]);
  execFileSync("git", ["-C", checkout, "config", "user.name", "someone"]);

  await hardenAgentGitDir(checkout);

  // Nothing an agent could read in the checkout holds the credential, in any encoding.
  for (const file of everyFileUnder(checkout)) {
    const content = fs.readFileSync(file, "latin1");
    assert.ok(!content.includes(TOKEN), file);
    assert.ok(!content.includes("eC1hY2Nlc3MtdG9rZW46"), file);
  }
  assert.equal(execFileSync("git", ["-C", checkout, "config", "user.name"]).toString().trim(), "someone");

  // The host still has it for its own fetch/push, outside the checkout and not in clear text.
  assert.equal(await readWorkspaceGithubToken(checkout), TOKEN);
  const stored = everyFileUnder(storeDir);
  assert.equal(stored.length, 1);
  assert.ok(!fs.readFileSync(stored[0], "latin1").includes(TOKEN));
  assert.ok(!stored[0].includes(path.basename(checkout)));
  assert.equal(fs.statSync(stored[0]).mode & 0o077, 0);

  // A run without GitHub access, and a deleted checkout, leave nothing behind.
  await stripWorkspaceGithubAuth(checkout);
  assert.equal(await readWorkspaceGithubToken(checkout), null);
  await forgetWorkspaceGithubToken(checkout);
  assert.equal(everyFileUnder(storeDir).length, 0);
});

test("a run event is masked before it is stored", async () => {
  const user = await db.user.create({
    data: { email: `mask-${crypto.randomUUID()}@example.com`, name: "mask", passwordHash: "x" }
  });
  created.users.push(user.id);
  const doc = await db.document.create({
    data: { title: "mask", content: JSON.stringify({ type: "doc", content: [] }), ownerId: user.id }
  });
  created.documents.push(doc.id);
  const run = await db.aiRun.create({
    data: { documentId: doc.id, triggerType: "CONVERSATION", instruction: "t", status: "RUNNING" }
  });
  rememberRunSecrets(run.id, { DEPLOY_PASSWORD: "hunter2-but-longer" });
  await recordAiRunEvent({
    aiRunId: run.id,
    role: "tool_result",
    message: `To https://x-access-token:${TOKEN}@github.com/a/b.git\nDEPLOY_PASSWORD=hunter2-but-longer`
  });
  const [event] = await db.aiRunEvent.findMany({ where: { aiRunId: run.id } });
  assert.ok(!event.message.includes(TOKEN));
  assert.ok(!event.message.includes("hunter2-but-longer"));
  assert.ok(event.message.startsWith("To https://x-access-token:ghp_****"));
});
