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

async function makeUser(prefix: string, defaults?: { model?: string; effort?: string }) {
  return db.user.create({
    data: {
      email: `${prefix}-${crypto.randomUUID()}@example.com`,
      name: prefix,
      passwordHash: "x",
      defaultAgentModel: defaults?.model ?? null,
      defaultAgentEffort: defaults?.effort ?? null
    }
  });
}

test("resolveAgentConfigForUser falls back doc -> user default -> null", async () => {
  const { resolveAgentConfigForUser } = await import("../lib/agent-defaults");

  const alice = await makeUser("doc-default-model", { model: "claude-fable-5", effort: "medium" });

  // Doc unset -> user default wins.
  assert.deepEqual(
    await resolveAgentConfigForUser({ agentModel: null, agentEffort: null }, alice.id),
    { model: "claude-fable-5", effort: "medium" }
  );

  // Doc pinned -> doc wins.
  assert.deepEqual(
    await resolveAgentConfigForUser({ agentModel: "claude-opus-4-8", agentEffort: "high" }, alice.id),
    { model: "claude-opus-4-8", effort: "high" }
  );

  // Partial pin -> mix per-field.
  assert.deepEqual(
    await resolveAgentConfigForUser({ agentModel: "claude-opus-4-8", agentEffort: null }, alice.id),
    { model: "claude-opus-4-8", effort: "medium" }
  );

  // Anonymous (share-link) trigger -> app default (nulls).
  assert.deepEqual(
    await resolveAgentConfigForUser({ agentModel: null, agentEffort: null }, null),
    { model: null, effort: null }
  );

  // User without a personal default -> app default (nulls).
  const bob = await makeUser("doc-default-model-none");
  assert.deepEqual(
    await resolveAgentConfigForUser({ agentModel: null, agentEffort: null }, bob.id),
    { model: null, effort: null }
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
