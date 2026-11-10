import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { resolveAgentApiChannel, upsertAgentApiChannel } from "../lib/agent-api-channels";
import { agentSetupSchema } from "../lib/agent-setup";
import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";
import {
  applyRunCredentialPolicy,
  effectiveChannelRunPolicy,
  parseChannelCredentialCeiling,
  runCredentialChoices
} from "../lib/run-credential-policy";

test("a channel without a ceiling leaves the caller's policy untouched", () => {
  assert.equal(effectiveChannelRunPolicy(null, null), null);
  const requested = { allowEnv: ["A"], env: { B: "1" }, allowMcpServers: [] };
  assert.deepEqual(effectiveChannelRunPolicy(null, requested), requested);
});

test("a ceiling restricts every run and cannot be widened by the caller", () => {
  const ceiling = { allowEnv: ["ANTHROPIC_API_KEY", "RUNPOD_API_KEY"], allowMcpServers: ["notes"] };
  // No `credentials` from the caller: still restricted, to the whole ceiling.
  assert.deepEqual(effectiveChannelRunPolicy(ceiling, null), {
    allowEnv: ["ANTHROPIC_API_KEY", "RUNPOD_API_KEY"], env: {}, allowMcpServers: ["notes"]
  });
  // Asking for more yields only the overlap; per-run values pass through.
  const widened = effectiveChannelRunPolicy(ceiling, {
    allowEnv: ["RUNPOD_API_KEY", "GITHUB_TOKEN", "HF_TOKEN"], env: { BACKLOG_TOKEN: "rb_x" }, allowMcpServers: ["notes", "mail"]
  });
  assert.deepEqual(widened, { allowEnv: ["RUNPOD_API_KEY"], env: { BACKLOG_TOKEN: "rb_x" }, allowMcpServers: ["notes"] });
  const { env } = applyRunCredentialPolicy(
    { ANTHROPIC_API_KEY: "a", RUNPOD_API_KEY: "r", GITHUB_TOKEN: "g", HF_TOKEN: "h" },
    widened!
  );
  assert.deepEqual(env, { RUNPOD_API_KEY: "r", BACKLOG_TOKEN: "rb_x" });
});

test("an unreadable stored ceiling fails closed", () => {
  assert.equal(parseChannelCredentialCeiling(null), null);
  assert.deepEqual(parseChannelCredentialCeiling("{not json"), { allowEnv: [], allowMcpServers: [] });
  assert.deepEqual(parseChannelCredentialCeiling(JSON.stringify({ allowEnv: ["bad name"] })), { allowEnv: [], allowMcpServers: [] });
  assert.deepEqual(parseChannelCredentialCeiling(JSON.stringify({ allowEnv: ["A"] })), { allowEnv: ["A"], allowMcpServers: [] });
});

test("consent-page choices map connected credentials to env names", () => {
  const choices = runCredentialChoices([
    { provider: "anthropic", kind: "oauth" },
    { provider: "litellm", kind: "api_key" },
    { provider: "huggingface", kind: "api_key" },
    { provider: "github", kind: "api_key" }
  ]);
  assert.deepEqual(choices.map((c) => [c.envNames, c.model]), [
    [["CLAUDE_CODE_OAUTH_TOKEN"], true],
    [["LITELLM_API_KEY"], true],
    [["HF_TOKEN"], false],
    [["GITHUB_TOKEN", "GH_TOKEN"], false]
  ]);
  assert.deepEqual(runCredentialChoices([{ provider: "anthropic", kind: "api_key" }])[0].envNames, ["ANTHROPIC_API_KEY"]);
});

test("the setup payload accepts a credential choice and rejects bad names", () => {
  const base = {
    title: "t", markdown: "", environment: {}, skillMarkdown: "x", skillName: "s",
    callbackUrl: "https://example.com/cb", callbackCredential: "c"
  };
  assert.equal(agentSetupSchema.safeParse(base).success, true);
  assert.equal(agentSetupSchema.safeParse({ ...base, credentials: { allowEnv: ["RUNPOD_API_KEY"] } }).success, true);
  assert.equal(agentSetupSchema.safeParse({ ...base, credentials: { allowEnv: ["no spaces"] } }).success, false);
});

test("rotating a channel token keeps its ceiling", async () => {
  const user = await db.user.create({
    data: { email: `ceiling-${crypto.randomUUID()}@example.com`, name: "Ceiling", passwordHash: "x" }
  });
  const document = await db.document.create({
    data: { ownerId: user.id, title: "Ceiling", content: serializeDocumentContent({ type: "doc", content: [{ type: "paragraph" }] }) }
  });
  try {
    const stored = JSON.stringify({ allowEnv: ["LITELLM_API_KEY"], allowMcpServers: [] });
    const first = await upsertAgentApiChannel({ documentId: document.id, createdById: user.id, credentialPolicy: stored });
    const rotated = await upsertAgentApiChannel({ documentId: document.id, createdById: user.id });
    assert.equal(await resolveAgentApiChannel(first.channel.id, `Bearer ${first.token}`), null);
    const channel = await resolveAgentApiChannel(rotated.channel.id, `Bearer ${rotated.token}`);
    assert.equal(channel?.credentialPolicy, stored);
  } finally {
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
  }
});
