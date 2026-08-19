import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { db } from "../lib/db";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

// The user's personal default agent config (User.defaultAgentModel/-Effort)
// must apply to ALL agent surfaces, not just Slack. Regression: creating a new
// document and asking the AI ran on the app default (sonnet-5) even though the
// user had set a personal default, because the doc-app routes passed
// document.agentModel straight through.

async function makeUser(
  prefix: string,
  defaults?: { model?: string; effort?: string; instructions?: string }
) {
  return db.user.create({
    data: {
      email: `${prefix}-${crypto.randomUUID()}@example.com`,
      name: prefix,
      passwordHash: "x",
      defaultAgentModel: defaults?.model ?? null,
      defaultAgentEffort: defaults?.effort ?? null,
      agentInstructions: defaults?.instructions ?? null
    }
  });
}

test("resolveAgentConfigForUser falls back doc -> user default -> null", async () => {
  const { resolveAgentConfigForUser } = await import("../lib/agent-defaults");

  const alice = await makeUser("doc-default-model", { model: "claude-fable-5", effort: "medium" });

  // Doc unset -> user default wins.
  assert.deepEqual(
    await resolveAgentConfigForUser({ agentModel: null, agentEffort: null }, alice.id),
    { model: "claude-fable-5", effort: "medium", userInstructions: null }
  );

  // Doc pinned -> doc wins.
  assert.deepEqual(
    await resolveAgentConfigForUser({ agentModel: "claude-opus-4-8", agentEffort: "high" }, alice.id),
    { model: "claude-opus-4-8", effort: "high", userInstructions: null }
  );

  // Partial pin -> mix per-field.
  assert.deepEqual(
    await resolveAgentConfigForUser({ agentModel: "claude-opus-4-8", agentEffort: null }, alice.id),
    { model: "claude-opus-4-8", effort: "medium", userInstructions: null }
  );

  // Anonymous (share-link) trigger -> app default (nulls).
  assert.deepEqual(
    await resolveAgentConfigForUser({ agentModel: null, agentEffort: null }, null),
    { model: null, effort: null, userInstructions: null }
  );

  // User without a personal default -> app default (nulls).
  const bob = await makeUser("doc-default-model-none");
  assert.deepEqual(
    await resolveAgentConfigForUser({ agentModel: null, agentEffort: null }, bob.id),
    { model: null, effort: null, userInstructions: null }
  );
});

// Custom instructions (User.agentInstructions) ride along in EVERY resolved
// config — even when the document pins its own model — because they are a
// user-scoped personalization, not a doc-overridable model setting.
test("resolveAgentConfigForUser carries the user's custom instructions in all cases", async () => {
  const { resolveAgentConfigForUser } = await import("../lib/agent-defaults");

  const carol = await makeUser("doc-instructions", {
    instructions: "  Always answer in German.  "
  });

  // No doc pin -> instructions present (and trimmed).
  assert.deepEqual(
    await resolveAgentConfigForUser({ agentModel: null, agentEffort: null }, carol.id),
    { model: null, effort: null, userInstructions: "Always answer in German." }
  );

  // Doc fully pinned -> instructions STILL present (not doc-overridable).
  assert.deepEqual(
    await resolveAgentConfigForUser({ agentModel: "claude-opus-4-8", agentEffort: "high" }, carol.id),
    { model: "claude-opus-4-8", effort: "high", userInstructions: "Always answer in German." }
  );

  // Whitespace-only instructions normalize to null.
  const dave = await makeUser("doc-instructions-blank", { instructions: "   " });
  assert.deepEqual(
    await resolveAgentConfigForUser({ agentModel: null, agentEffort: null }, dave.id),
    { model: null, effort: null, userInstructions: null }
  );
});

// The instructions must actually land in the system prompt both harnesses use
// (codex-agent.ts wraps buildSystemPrompt, so one assertion covers both).
test("buildSystemPrompt injects userInstructions for every mode, and omits the block otherwise", async () => {
  const { buildSystemPrompt } = await import("../agent-core/agent");

  const base = {
    accessMode: "workspace" as const,
    documentTitle: "Doc",
    documentText: "Body",
    instruction: "Do it",
    anchorText: "Body",
    unresolvedThreads: [],
    workspacePath: null,
    workspaceOverview: ""
  };

  for (const mode of ["edit_selection", "comment_reply", "conversation"] as const) {
    const prompt = buildSystemPrompt({
      ...base,
      mode,
      userInstructions: "Always answer in German."
    } as Parameters<typeof buildSystemPrompt>[0]);
    assert.ok(
      prompt.includes("Always answer in German."),
      `mode ${mode} must include the user's custom instructions`
    );
    assert.ok(
      prompt.includes("Custom instructions from the user"),
      `mode ${mode} must label the custom-instructions block`
    );
  }

  const withoutPrompt = buildSystemPrompt({
    ...base,
    mode: "conversation"
  } as Parameters<typeof buildSystemPrompt>[0]);
  assert.ok(
    !withoutPrompt.includes("Custom instructions from the user"),
    "no instructions -> no block"
  );
});

// Every doc-app agent entry point must resolve the user default rather than
// passing document.agentModel through raw. Source-level guard (same pattern as
// widget-isolation.test.ts) so a new inline `access.document.agentModel`
// regression fails loudly.
test("all agent entry points resolve the user's default agent config", () => {
  const entryPoints = [
    "app/api/documents/[id]/ai-edit/route.ts",
    "app/api/documents/[id]/agents/route.ts",
    "lib/ask-ai.ts",
    "lib/slack/events.ts"
  ];
  for (const rel of entryPoints) {
    const source = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    assert.ok(
      source.includes("resolveAgentConfigForUser"),
      `${rel} must resolve agent config via resolveAgentConfigForUser (user default fallback)`
    );
  }
});
