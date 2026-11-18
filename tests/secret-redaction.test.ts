import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  knownRunSecrets,
  redactDirectoryInPlace,
  redactFileInPlace,
  redactSecrets,
  rememberRunSecrets
} from "../lib/secret-redaction";

// Built at run time so this file never contains something shaped like a live token.
const GH = `ghp_${"A1b2C3d4E5f6G7h8I9j0".repeat(2).slice(0, 36)}`;
const BASIC = Buffer.from(`x-access-token:${GH}`).toString("base64");
const KEY_BODY = ["b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", "QyNTUxOQAAACDx0wJb7sQ0h7mE5b1c2d3e4f5g6h7i8j9k0l"];
const PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_BODY.join("\n")}\n-----END OPENSSH PRIVATE KEY-----`;

test("the forms in which the GitHub token reached run logs are masked", () => {
  const counts: Record<string, number> = {};
  const out = redactSecrets(
    [
      `origin\thttps://x-access-token:${GH}@github.com/acme/repo.git (push)`,
      `GH_TOKEN=${GH}`,
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${BASIC}`
    ].join("\n"),
    null,
    counts
  );
  assert.ok(!out.includes(GH));
  assert.ok(!out.includes(BASIC));
  assert.ok(out.includes(`https://x-access-token:ghp_${"*".repeat(36)}@github.com/acme/repo.git`));
  assert.ok(out.includes("GH_TOKEN=ghp_****"));
  assert.equal(counts["GitHub token"], 2);
  assert.equal(counts["GitHub basic credential"], 1);
});

test("masking keeps the length, is idempotent and leaves ordinary text alone", () => {
  const text = `before ${GH} after`;
  const once = redactSecrets(text);
  assert.equal(once.length, text.length);
  assert.equal(redactSecrets(once), once);
  for (const plain of [
    "a task-oriented risk-assessment of sk-learn and hf_hub",
    "commit 4f9c2d1e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d",
    "rdocs-vk-" + "0".repeat(48),
    "https://github.com/acme/repo/blob/main/ghp_notes.md"
  ]) {
    assert.equal(redactSecrets(plain), plain);
  }
});

test("a private key block is masked, also inside JSON, also when its end was clipped", () => {
  const masked = redactSecrets(`key:\n${PRIVATE_KEY}\ndone`);
  for (const line of KEY_BODY) assert.ok(!masked.includes(line));
  assert.ok(masked.includes("-----BEGIN OPENSSH PRIVATE KEY-----"));
  assert.ok(masked.includes("-----END OPENSSH PRIVATE KEY-----"));
  assert.ok(masked.endsWith("\ndone"));

  const json = JSON.stringify({ stdout: PRIVATE_KEY, exit: 0 });
  const maskedJson = redactSecrets(json);
  assert.equal(maskedJson.length, json.length);
  const parsed = JSON.parse(maskedJson) as { stdout: string; exit: number };
  assert.equal(parsed.exit, 0);
  assert.equal(parsed.stdout.split("\n").length, PRIVATE_KEY.split("\n").length);
  for (const line of KEY_BODY) assert.ok(!maskedJson.includes(line));

  const clipped = redactSecrets(`${PRIVATE_KEY.slice(0, 70)}...`);
  assert.ok(!clipped.includes(KEY_BODY[0].slice(0, 20)));
});

test("a secret the run holds is masked even without a known shape", () => {
  rememberRunSecrets("run-1", {
    MY_SERVICE_PASSWORD: "correct horse battery staple",
    LITELLM_BASE_URL: "http://127.0.0.1:9274",
    SHORT_TOKEN: "abc",
    PLAIN_SETTING: "not-a-secret-value"
  });
  const known = knownRunSecrets("run-1");
  assert.deepEqual([...known!], ["correct horse battery staple"]);
  const out = redactSecrets("login with correct horse battery staple and not-a-secret-value", known);
  assert.equal(out, `login with ${"*".repeat(28)} and not-a-secret-value`);
  assert.equal(knownRunSecrets("run-unknown"), undefined);
});

test("a transcript file is masked in place: same size, same inode, appends survive", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redact-"));
  try {
    const file = path.join(dir, "session.jsonl");
    const line = (text: string) => `${JSON.stringify({ type: "tool_result", content: text })}\n`;
    fs.writeFileSync(file, line("x".repeat(3000)) + line(`To https://x-access-token:${GH}@github.com/a/b.git`) + line(PRIVATE_KEY));
    const before = fs.statSync(file);
    const appender = fs.openSync(file, "a");
    const masked = await redactFileInPlace(file);
    fs.writeSync(appender, line("written by the process that still had the file open"));
    fs.closeSync(appender);
    assert.ok(masked >= 2);
    const after = fs.statSync(file);
    assert.equal(after.ino, before.ino);
    const content = fs.readFileSync(file, "utf8");
    assert.ok(!content.includes(GH));
    for (const body of KEY_BODY) assert.ok(!content.includes(body));
    const lines = content.trim().split("\n").map((entry) => JSON.parse(entry) as { content: string });
    assert.equal(lines.length, 4);
    assert.equal(lines[3].content, "written by the process that still had the file open");
    assert.equal(await redactFileInPlace(file), 0, "nothing left to mask");

    // Only files the run touched are opened.
    const old = path.join(dir, "old.jsonl");
    fs.writeFileSync(old, line(GH));
    fs.utimesSync(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    const result = await redactDirectoryInPlace(dir, { since: new Date(Date.now() - 60_000) });
    assert.equal(result.files, 1);
    assert.ok(fs.readFileSync(old, "utf8").includes(GH));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
