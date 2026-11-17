import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import {
  AgentPresetError,
  MAX_AGENT_PRESETS,
  agentPresetConfigSchema,
  deleteAgentPreset,
  listAgentPresets,
  saveAgentPreset,
  type AgentPresetConfig
} from "../lib/agent-presets";
import { AgentSetupError, agentSetupSchema, provisionAgentSetup } from "../lib/agent-setup";
import { db } from "../lib/db";
import { getDocumentSkillDir, getUserSkillDir, prepareSkillUpload, writeSkillToStore } from "../lib/skills";

process.env.SESSION_SECRET ||= "agent-presets-test-secret";

async function makeUser(prefix: string) {
  return db.user.create({ data: { email: `${prefix}-${crypto.randomUUID()}@example.com`, name: prefix, passwordHash: "x" } });
}

async function addLibrarySkill(userId: string, name: string) {
  const prepared = prepareSkillUpload([
    { relativePath: `${name}/SKILL.md`, bytes: Buffer.from(`---\nname: ${name}\ndescription: how to ${name}\n---\n\nUse ${name}.`) }
  ]);
  await writeSkillToStore(getUserSkillDir(userId, prepared.name), prepared);
  await db.userSkill.create({ data: { userId, name: prepared.name, description: prepared.description } });
}

const config = (extra: Partial<AgentPresetConfig> = {}): AgentPresetConfig => ({
  agentModel: "claude-opus-latest",
  agentEffort: "high",
  skills: ["tinker"],
  credentialIds: ["github"],
  budget: { provisionerDocumentId: "doc1", budgetUsd: 50, costProjectParent: "srf" },
  ...extra
});

test("presets: saved by name, replaced, listed and deleted per user; invalid configs are refused", async () => {
  const user = await makeUser("preset-owner");
  const other = await makeUser("preset-other");

  const saved = await saveAgentPreset(user.id, "Careful Opus, $50", config());
  await saveAgentPreset(user.id, "Cheap", config({ agentModel: "codex/litellm/openai/gpt-5.6-terra", agentEffort: null, skills: [], budget: null }));
  assert.deepEqual((await listAgentPresets(user.id)).map((preset) => preset.name), ["Careful Opus, $50", "Cheap"]);
  assert.deepEqual(await listAgentPresets(other.id), [], "presets are private to their user");

  // the same name replaces the preset instead of adding one
  const replaced = await saveAgentPreset(user.id, "Careful Opus, $50", config({ agentEffort: "max" }));
  assert.equal(replaced.id, saved.id);
  const listed = await listAgentPresets(user.id);
  assert.equal(listed.length, 2);
  assert.equal(listed[0].config.agentEffort, "max");
  assert.deepEqual(listed[0].config.budget, { provisionerDocumentId: "doc1", budgetUsd: 50, costProjectParent: "srf" });

  // nobody else can delete it
  assert.equal(await deleteAgentPreset(other.id, saved.id), false);
  assert.equal(await deleteAgentPreset(user.id, saved.id), true);
  assert.deepEqual((await listAgentPresets(user.id)).map((preset) => preset.name), ["Cheap"]);

  for (const bad of [
    config({ agentModel: "gpt-nonsense" }),
    config({ agentEffort: "ludicrous" as never }),
    config({ budget: { provisionerDocumentId: "doc1", budgetUsd: -1, costProjectParent: null } })
  ]) {
    assert.equal(agentPresetConfigSchema.safeParse(bad).success, false);
  }
  // a stored config that no longer validates (a model that was removed) is left out, not served
  await db.agentPreset.create({ data: { userId: user.id, name: "Stale", config: JSON.stringify(config({ agentModel: "gpt-nonsense" })) } });
  assert.deepEqual((await listAgentPresets(user.id)).map((preset) => preset.name), ["Cheap"]);

  const hoarder = await makeUser("preset-hoarder");
  for (let i = 0; i < MAX_AGENT_PRESETS; i++) await saveAgentPreset(hoarder.id, `p${i}`, config());
  await assert.rejects(saveAgentPreset(hoarder.id, "one too many", config()), AgentPresetError);
  await saveAgentPreset(hoarder.id, "p0", config({ agentEffort: "low" })); // replacing still works at the limit
});

test("agent setup: the chosen model, effort and library skills configure the workspace; the integration learns the names", async () => {
  const callbacks: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      callbacks.push(JSON.parse(raw));
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const saved = { origins: process.env.AGENT_SETUP_ALLOWED_ORIGINS, appUrl: process.env.APP_URL };
  process.env.AGENT_SETUP_ALLOWED_ORIGINS = origin;
  process.env.APP_URL = "http://localhost:14141";
  try {
    const user = await makeUser("preset-setup");
    await addLibrarySkill(user.id, "tinker");
    await addLibrarySkill(user.id, "vibes-eval");
    await addLibrarySkill(user.id, "backlog"); // same name as the integration's skill
    const setup = (extra: Record<string, unknown> = {}) =>
      provisionAgentSetup(
        user.id,
        agentSetupSchema.parse({
          title: "Backlog run: probes",
          markdown: "# Task",
          environment: {},
          skillMarkdown: "---\nname: backlog\ndescription: the integration's own instructions\n---\n\nDo the task.",
          skillName: "backlog",
          callbackUrl: `${origin}/cb`,
          callbackCredential: "one-time",
          ...extra
        })
      );

    const result = await setup({
      agentModel: "codex/litellm/openai/gpt-5.6-terra",
      agentEffort: "high",
      skills: ["vibes-eval", "tinker", "backlog"],
      presetName: "Careful Codex"
    });
    const document = await db.document.findUniqueOrThrow({ where: { id: result.documentId } });
    assert.deepEqual([document.agentModel, document.agentEffort], ["codex/litellm/openai/gpt-5.6-terra", "high"]);
    const attached = await db.documentSkill.findMany({ where: { documentId: result.documentId }, orderBy: { name: "asc" } });
    assert.deepEqual(attached.map((skill) => skill.name), ["backlog", "tinker", "vibes-eval"]);
    // the integration's skill wins the name clash: its text, not the library's
    assert.equal(attached[0].description, "the integration's own instructions");
    assert.match(fs.readFileSync(path.join(getDocumentSkillDir(result.documentId, "backlog"), "SKILL.md"), "utf8"), /Do the task/);
    assert.match(fs.readFileSync(path.join(getDocumentSkillDir(result.documentId, "tinker"), "SKILL.md"), "utf8"), /Use tinker/);
    // names only reach the integration
    assert.deepEqual(callbacks[0].agent, {
      preset: "Careful Codex",
      model: "codex/litellm/openai/gpt-5.6-terra",
      effort: "high",
      skills: ["tinker", "vibes-eval"]
    });

    // nothing chosen: the workspace follows the user's defaults, as before
    const plain = await setup();
    const untouched = await db.document.findUniqueOrThrow({ where: { id: plain.documentId } });
    assert.equal(untouched.agentEffort, null);
    assert.deepEqual(callbacks[1].agent, { preset: null, model: null, effort: null, skills: [] });
    assert.equal(await db.documentSkill.count({ where: { documentId: plain.documentId } }), 1);

    // a skill that is not in the library, or a model r-docs cannot run: refused before a workspace exists
    const before = await db.document.count({ where: { ownerId: user.id } });
    await assert.rejects(setup({ skills: ["tinker", "gone"] }), (error: unknown) => error instanceof AgentSetupError && /Not in your skill library: gone/.test(error.message));
    await assert.rejects(setup({ agentModel: "gpt-nonsense" }), AgentSetupError);
    assert.equal(await db.document.count({ where: { ownerId: user.id } }), before);
    assert.equal(callbacks.length, 2);
    // someone else's library skill is not reachable by name
    const stranger = await makeUser("preset-stranger");
    await assert.rejects(
      provisionAgentSetup(stranger.id, agentSetupSchema.parse({
        title: "x", markdown: "", environment: {}, skillMarkdown: "---\nname: s\ndescription: d\n---\n\nx", skillName: "s",
        callbackUrl: `${origin}/cb`, callbackCredential: "c", skills: ["tinker"]
      })),
      AgentSetupError
    );
  } finally {
    process.env.AGENT_SETUP_ALLOWED_ORIGINS = saved.origins;
    process.env.APP_URL = saved.appUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
