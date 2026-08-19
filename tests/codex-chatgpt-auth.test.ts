import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Same-process key: credentials created below are decrypted with this key.
process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

import {
  agentModelProvider,
  defaultCodexAgentModelForCredentials,
  isStorableAgentModel,
  resolveCodexAgentConfig
} from "../agent-core/agent-config";
import { collectRefreshedCodexAuth, seedCodexChatgptAuth } from "../agent-core/codex-agent";
import {
  CONNECT_CHATGPT_CREDENTIAL_MESSAGE,
  resolveContainerCredentialEnv
} from "../lib/agent-runner/agent-credential";
import { detectCredential, looksLikeCodexAuthJson } from "../lib/credential-detect";
import { db } from "../lib/db";
import { upsertDocumentEnv } from "../lib/document-env";
import {
  codexAuthLastRefreshMs,
  loadAgentEnvForDocument,
  normalizeCodexAuthJson,
  persistRefreshedCodexAuth,
  getUserCredential,
  upsertUserCredential
} from "../lib/user-credentials";

function authJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: "id-tok",
      access_token: "acc-tok",
      refresh_token: "ref-tok",
      account_id: "acct-1"
    },
    last_refresh: "2026-08-01T00:00:00.000Z",
    ...overrides
  });
}

// --- Model plumbing ---------------------------------------------------------

test("codex/chatgpt models route to the openai-chatgpt provider", () => {
  assert.equal(agentModelProvider("codex/chatgpt/gpt-5.6-terra"), "openai-chatgpt");
  assert.equal(isStorableAgentModel("codex/chatgpt/gpt-5.6-terra"), true);
  const resolved = resolveCodexAgentConfig({ model: "codex/chatgpt/gpt-5.6-terra" });
  assert.equal(resolved.provider, "chatgpt");
  assert.equal(resolved.model, "gpt-5.6-terra");
});

test("harness default prefers OpenAI key, then ChatGPT subscription, then LiteLLM", () => {
  assert.match(
    defaultCodexAgentModelForCredentials({ hasOpenAiKey: true, hasLiteLlmKey: true, hasChatgptAuth: true }),
    /^codex\/openai\//
  );
  assert.match(
    defaultCodexAgentModelForCredentials({ hasOpenAiKey: false, hasLiteLlmKey: true, hasChatgptAuth: true }),
    /^codex\/chatgpt\//
  );
  assert.match(
    defaultCodexAgentModelForCredentials({ hasOpenAiKey: false, hasLiteLlmKey: true, hasChatgptAuth: false }),
    /^codex\/litellm\//
  );
});

// --- Credential detection / validation --------------------------------------

test("a pasted auth.json is detected as an openai-chatgpt credential", () => {
  assert.equal(looksLikeCodexAuthJson(authJson()), true);
  assert.equal(detectCredential(authJson())?.provider, "openai-chatgpt");
  assert.equal(looksLikeCodexAuthJson("sk-ant-api03-abc"), false);
});

test("normalizeCodexAuthJson compacts valid files and rejects unusable ones", () => {
  const pretty = JSON.stringify(JSON.parse(authJson()), null, 2);
  const normalized = normalizeCodexAuthJson(pretty);
  assert.equal(normalized.includes("\n"), false);
  assert.deepEqual(JSON.parse(normalized), JSON.parse(pretty));

  assert.throws(() => normalizeCodexAuthJson("not json"), /auth\.json/);
  assert.throws(() => normalizeCodexAuthJson(JSON.stringify({ tokens: {} })), /refresh_token/);
  assert.throws(
    () => normalizeCodexAuthJson(JSON.stringify({ auth_mode: "apikey", tokens: { refresh_token: "r" } })),
    /auth_mode/
  );
});

test("codexAuthLastRefreshMs parses the rotation timestamp", () => {
  assert.equal(codexAuthLastRefreshMs(authJson()), Date.parse("2026-08-01T00:00:00.000Z"));
  assert.equal(codexAuthLastRefreshMs(authJson({ last_refresh: undefined })), null);
  assert.equal(codexAuthLastRefreshMs("garbled"), null);
});

// --- Seeding + rotation read-back (fs layer) ---------------------------------

test("seedCodexChatgptAuth materializes the blob into $CODEX_HOME/auth.json with 0600", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
  try {
    const blob = authJson();
    const authPath = await seedCodexChatgptAuth({ CODEX_CHATGPT_AUTH_JSON: blob, CODEX_HOME: home });
    assert.equal(authPath, path.join(home, "auth.json"));
    assert.equal(await fs.readFile(authPath, "utf8"), blob);
    if (process.platform !== "win32") {
      const mode = (await fs.stat(authPath)).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("seedCodexChatgptAuth refuses to run without the blob or CODEX_HOME", async () => {
  await assert.rejects(seedCodexChatgptAuth({ CODEX_HOME: "/tmp/x" }), /CODEX_CHATGPT_AUTH_JSON/);
  await assert.rejects(seedCodexChatgptAuth({ CODEX_CHATGPT_AUTH_JSON: authJson() }), /CODEX_HOME/);
});

test("collectRefreshedCodexAuth propagates only a changed, well-formed auth.json", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
  try {
    const seeded = authJson();
    const authPath = path.join(home, "auth.json");
    const calls: string[] = [];
    const onRefreshed = (value: string) => {
      calls.push(value);
    };

    // Missing file → nothing to persist.
    await collectRefreshedCodexAuth(authPath, seeded, onRefreshed);
    // Unchanged file → nothing to persist.
    await fs.writeFile(authPath, seeded);
    await collectRefreshedCodexAuth(authPath, seeded, onRefreshed);
    // Garbled file → nothing to persist.
    await fs.writeFile(authPath, "{ not json");
    await collectRefreshedCodexAuth(authPath, seeded, onRefreshed);
    assert.deepEqual(calls, []);

    // Rotated file → handed to the callback verbatim.
    const rotated = authJson({ last_refresh: "2026-08-19T00:00:00.000Z" });
    await fs.writeFile(authPath, rotated);
    await collectRefreshedCodexAuth(authPath, seeded, onRefreshed);
    assert.deepEqual(calls, [rotated]);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

// --- Container credential guard ----------------------------------------------

test("chatgpt containers require the resolved auth blob, never host files", () => {
  const withBlob = resolveContainerCredentialEnv(
    { CODEX_CHATGPT_AUTH_JSON: authJson() },
    "codex/chatgpt/gpt-5.6-terra",
    { homeDir: "/host-home-that-must-never-be-read" }
  );
  assert.deepEqual(withBlob, { added: {}, warning: null, error: null });

  const missing = resolveContainerCredentialEnv({}, "codex/chatgpt/gpt-5.6-terra", {
    homeDir: "/host-home"
  });
  assert.deepEqual(missing.added, {});
  assert.equal(missing.error, CONNECT_CHATGPT_CREDENTIAL_MESSAGE);
  assert.doesNotMatch(missing.error ?? "", /host|codex login/i);
});

// --- DB resolution + rotation persistence -------------------------------------

const created = { users: [] as string[], documents: [] as string[] };

async function makeUser(prefix: string) {
  const user = await db.user.create({
    data: { email: `${prefix}-${crypto.randomUUID()}@example.com`, name: prefix, passwordHash: "x" }
  });
  created.users.push(user.id);
  return user;
}

async function makeDoc(ownerId: string) {
  const doc = await db.document.create({
    data: {
      title: "codex chatgpt auth test",
      content: JSON.stringify({ type: "doc", content: [] }),
      ownerId
    }
  });
  created.documents.push(doc.id);
  return doc;
}

test.after(async () => {
  await db.document.deleteMany({ where: { id: { in: created.documents } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
  await db.$disconnect();
});

test("a connected ChatGPT credential rides CODEX_CHATGPT_AUTH_JSON into the run env", async () => {
  const owner = await makeUser("chatgpt-env");
  const doc = await makeDoc(owner.id);
  await upsertUserCredential(owner.id, {
    provider: "openai-chatgpt",
    kind: "oauth",
    value: normalizeCodexAuthJson(authJson())
  });

  const env = await loadAgentEnvForDocument(doc.id, "codex/chatgpt/gpt-5.6-terra", owner.id);
  assert.equal(env.CODEX_CHATGPT_AUTH_JSON, normalizeCodexAuthJson(authJson()));
  // The blob is the model credential, not a tool credential — an unrelated
  // model must not receive it.
  await upsertUserCredential(owner.id, { provider: "openai", kind: "api_key", value: "sk-test-openai" });
  const other = await loadAgentEnvForDocument(doc.id, "codex/openai/gpt-5.6-terra", owner.id);
  assert.equal(other.CODEX_CHATGPT_AUTH_JSON, undefined);
});

test("persistRefreshedCodexAuth updates the runner's stored credential (last-writer-wins)", async () => {
  const owner = await makeUser("chatgpt-rotate");
  const doc = await makeDoc(owner.id);
  await upsertUserCredential(owner.id, {
    provider: "openai-chatgpt",
    kind: "oauth",
    value: normalizeCodexAuthJson(authJson())
  });

  const rotated = authJson({ last_refresh: "2026-08-19T12:00:00.000Z" });
  const result = await persistRefreshedCodexAuth(doc.id, owner.id, rotated);
  assert.equal(result.persisted, true);
  const stored = await getUserCredential(owner.id, "openai-chatgpt");
  assert.equal(stored?.value, normalizeCodexAuthJson(rotated));

  // An OLDER rotation must never clobber a newer stored credential.
  const stale = await persistRefreshedCodexAuth(doc.id, owner.id, authJson());
  assert.equal(stale.persisted, false);
  assert.equal((await getUserCredential(owner.id, "openai-chatgpt"))?.value, normalizeCodexAuthJson(rotated));
});

test("persistRefreshedCodexAuth never writes doc-env credentials or garbage back", async () => {
  const owner = await makeUser("chatgpt-docenv");
  const doc = await makeDoc(owner.id);
  await upsertUserCredential(owner.id, {
    provider: "openai-chatgpt",
    kind: "oauth",
    value: normalizeCodexAuthJson(authJson())
  });
  await upsertDocumentEnv(doc.id, "CODEX_CHATGPT_AUTH_JSON", authJson());

  // Doc-env-sourced blob: the rotation belongs to whoever manages the doc env.
  const fromDocEnv = await persistRefreshedCodexAuth(
    doc.id,
    owner.id,
    authJson({ last_refresh: "2026-08-20T00:00:00.000Z" })
  );
  assert.equal(fromDocEnv.persisted, false);

  // Garbled blob: refuse rather than store an unusable credential.
  const garbled = await persistRefreshedCodexAuth(doc.id, owner.id, "{ nope");
  assert.equal(garbled.persisted, false);
});

test("persistRefreshedCodexAuth is a no-op when nobody has a stored credential", async () => {
  const owner = await makeUser("chatgpt-none");
  const doc = await makeDoc(owner.id);
  const result = await persistRefreshedCodexAuth(doc.id, owner.id, authJson());
  assert.equal(result.persisted, false);
  assert.equal(await getUserCredential(owner.id, "openai-chatgpt"), null);
});
