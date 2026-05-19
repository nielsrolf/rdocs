import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemPrompt, buildUserPrompt, parseClaudeAgentOutput } from "../lib/ai";
import { detectEditAssetIntent } from "../lib/ai-asset-intent";

const baseInput = {
  mode: "edit_selection" as const,
  documentTitle: "GDocs AI",
  documentText: "Intro text",
  documentBlocks: [
    { type: "text" as const, text: "Intro text\n\n[Repository image: Accuracy plot; caption=Comparison; path=assets/accuracy.png]" },
    { type: "image" as const, src: "data:image/png;base64,abc", alt: "Pasted diagram" },
    {
      type: "text" as const,
      text: "[Interactive widget: Rollout explorer; build_cmd=python widgets/build_rollout.py; embed_source=assets/rollout.html]"
    }
  ],
  unresolvedThreads: [
    {
      id: "thread-1",
      anchorText: "Intro text",
      anchorContext: "Intro text near the top",
      comments: [{ author: "Niels", body: "Can this include a figure?" }]
    }
  ],
  workspacePath: "/tmp/repo",
  workspaceOverview: "assets/accuracy.png\nwidgets/build_rollout.py",
  instruction: "Add a figure and a widget.",
  selectedText: "Intro text",
  selectedContext: "Intro text near the top"
};

test("system prompt includes rendering, media, widgets, comments, and workspace context", () => {
  const prompt = buildSystemPrompt(baseInput);

  assert.match(prompt, /renders replacementText as Markdown/);
  assert.match(prompt, /\$inline\$/);
  assert.match(prompt, /!\[Concise figure caption\]\(assets\/plot\.png\)/);
  assert.match(prompt, /Interactive widgets are repo files/);
  assert.match(prompt, /Inline pasted image: alt=Pasted diagram/);
  assert.match(prompt, /Interactive widget: Rollout explorer/);
  assert.match(prompt, /Thread thread-1/);
  assert.match(prompt, /assets\/accuracy\.png/);
});

test("edit prompt treats requested figures and widgets as hard requirements", () => {
  const prompt = buildUserPrompt(baseInput);

  assert.match(prompt, /Avoid a wall of text/);
  assert.match(prompt, /this is a hard requirement: create or choose at least one relevant repo-local image/);
  assert.match(prompt, /this is a hard requirement: populate the widgets array/);
  assert.match(prompt, /A valid widget is enough for an "or widget" request/);
});

test("asset intent accepts either asset for figure-or-widget requests", () => {
  assert.deepEqual(
    detectEditAssetIntent("Add a figure or widget to schematically illustrate the content of those prompts"),
    {
      wantsImage: true,
      wantsWidget: true,
      acceptsEitherAsset: true,
      requiresImage: false,
      requiresWidget: false,
      requiresAnyAsset: true
    }
  );

  assert.equal(detectEditAssetIntent("Add a figure and a tiny interactive widget").requiresImage, true);
  assert.equal(detectEditAssetIntent("Add a figure and a tiny interactive widget").requiresWidget, true);
});

test("comment prompt is constrained to comment replies and supports formatting", () => {
  const prompt = buildUserPrompt({
    ...baseInput,
    mode: "comment_reply" as const,
    anchorText: "Intro text",
    anchorContext: "Intro text near the top",
    comments: [{ author: "Niels", body: "What should this say?" }]
  });

  assert.match(prompt, /comment request can only post a comment reply/);
  assert.match(prompt, /short paragraphs, bullets, code fences/);
  assert.match(prompt, /Anchor: Intro text/);
});

test("malformed multiline replacementText is recovered without inserting raw JSON", () => {
  const output = parseClaudeAgentOutput(
    `{"replacementText":"## Heading

Useful prose with a table:

| A | B |
|---|---|
| 1 | 2 |","images":[],"widgets":[],"summary":"done"}`,
    "edit_selection"
  );

  assert.equal(output.replacementText?.startsWith("## Heading"), true);
  assert.equal(output.replacementText?.includes('{"replacementText"'), false);
});
