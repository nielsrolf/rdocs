import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import type { ClaudeResearchAgentInput } from "../agent-core/agent";
import type { SubmissionValidationSpec } from "../agent-core/edit-validation";
import { ContainerRunner } from "../lib/agent-runner/container";
import { loadAgentEnvForDocument } from "../lib/user-credentials";

const LIVE = process.env.RUN_LIVE_AGENT_E2E === "1";
const CODEX_MODEL = process.env.LIVE_CODEX_MODEL?.trim() || "codex/litellm/openai/gpt-5.6-terra";
const TIMEOUT_MS = 8 * 60 * 1000;

async function withLiveWorkspace<T>(run: (workspace: string, sessionDir: string) => Promise<T>) {
  const root = path.join(process.cwd(), ".research-workspaces");
  await fs.mkdir(root, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(root, "live-agent-e2e-workspace-"));
  const sessionDir = await fs.mkdtemp(path.join(root, "live-agent-e2e-session-"));
  try {
    return await run(workspace, sessionDir);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
}

async function runCodex(
  input: ClaudeResearchAgentInput,
  workspace: string,
  sessionDir: string,
  validation: SubmissionValidationSpec
) {
  const events: string[] = [];
  const runner = new ContainerRunner();
  const agentEnv = process.env.LIVE_DOCUMENT_ID
    ? await loadAgentEnvForDocument(
        process.env.LIVE_DOCUMENT_ID,
        CODEX_MODEL,
        process.env.LIVE_USER_ID?.trim() || null
      )
    : {
        ...(process.env.LITELLM_API_KEY ? { LITELLM_API_KEY: process.env.LITELLM_API_KEY } : {}),
        ...(process.env.LITELLM_BASE_URL ? { LITELLM_BASE_URL: process.env.LITELLM_BASE_URL } : {}),
        ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {})
      };
  try {
    return await runner.run(
      { ...input, workspacePath: workspace },
      {
        agentConfig: { model: CODEX_MODEL, effort: "low" },
        agentEnv,
        sessionDirHostPath: sessionDir,
        validation,
        containerName: `gdocs-live-codex-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        onProgress: (event) => {
          events.push(`${event.role}: ${event.message}`);
        }
      }
    );
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nTimeline:\n${events.join("\n")}`);
  }
}

test("live Codex container replies to a comment", { skip: !LIVE, timeout: TIMEOUT_MS }, async () => {
  await withLiveWorkspace(async (workspace, sessionDir) => {
    // A stale credential artifact from an older deployment must be removed;
    // authentication comes only from the resolved document/account env.
    await fs.writeFile(path.join(sessionDir, "auth.json"), "{}\n", { mode: 0o600 });
    const documentText = "The launch checklist is complete.";
    const result = await runCodex(
      {
        mode: "comment_reply",
        accessMode: "workspace",
        documentTitle: "Live Codex comment test",
        documentText,
        unresolvedThreads: [],
        workspacePath: workspace,
        workspaceOverview: "Empty disposable test workspace.",
        instruction: "Reply to the comment. Include the exact marker CODEX_COMMENT_OK in the reply.",
        anchorText: documentText,
        anchorContext: null,
        comments: [{ author: "E2E user", body: "Is this ready to ship?" }]
      },
      workspace,
      sessionDir,
      { kind: "comment_reply", documentText }
    );
    assert.match(result.reply ?? "", /CODEX_COMMENT_OK/);
    await assert.rejects(() => fs.access(path.join(sessionDir, "auth.json")));
  });
});

test("live Codex container makes a validated selection edit", { skip: !LIVE, timeout: TIMEOUT_MS }, async () => {
  await withLiveWorkspace(async (workspace, sessionDir) => {
    const selectedText = "The deployment status is red.";
    const result = await runCodex(
      {
        mode: "edit_selection",
        accessMode: "workspace",
        documentTitle: "Live Codex edit test",
        documentText: selectedText,
        unresolvedThreads: [],
        workspacePath: workspace,
        workspaceOverview: "Empty disposable test workspace.",
        instruction: "Replace the selected sentence so the deployment status is green.",
        selectedText,
        selectedMarkdown: selectedText,
        selectedContext: null
      },
      workspace,
      sessionDir,
      {
        kind: "edit_selection",
        selectedText,
        assetIntent: { requiresImage: false, requiresWidget: false, requiresAnyAsset: false },
        documentText: selectedText
      }
    );
    assert.match(result.replacementText ?? "", /green/i);
    assert.notEqual(result.replacementText, selectedText);
  });
});

test("live Codex container creates and validates a widget", { skip: !LIVE, timeout: TIMEOUT_MS }, async () => {
  await withLiveWorkspace(async (workspace, sessionDir) => {
    const selectedText = "Widget goes here.";
    const result = await runCodex(
      {
        mode: "edit_selection",
        accessMode: "workspace",
        documentTitle: "Live Codex widget test",
        documentText: selectedText,
        unresolvedThreads: [],
        workspacePath: workspace,
        workspaceOverview: "Empty disposable test workspace.",
        instruction:
          "Replace the selection with a tiny dependency-free interactive counter widget. Create widgets/live-codex/build.js which writes widgets/live-codex/index.html. Return build_cmd `node widgets/live-codex/build.js`, embed_source `widgets/live-codex/index.html`, and place the new widget at the selection.",
        selectedText,
        selectedMarkdown: selectedText,
        selectedContext: null
      },
      workspace,
      sessionDir,
      {
        kind: "edit_selection",
        selectedText,
        assetIntent: { requiresImage: false, requiresWidget: true, requiresAnyAsset: false },
        documentText: selectedText
      }
    );
    assert.equal(result.widgets?.length, 1);
    assert.match(result.replacementText ?? "", /widget:\/\/new/);
    const html = await fs.readFile(path.join(workspace, "widgets/live-codex/index.html"), "utf8");
    assert.match(html, /<html|<!doctype/i);
  });
});

test.skip("live Claude container replies to a comment");
test.skip("live Claude container makes a validated selection edit");
test.skip("live Claude container creates and validates a widget");
