import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemPrompt, buildUserPrompt } from "../lib/ai";
import { detectEditAssetIntent } from "../lib/ai-asset-intent";
import { getDocumentAiBlocks } from "../lib/content";

const baseInput = {
  mode: "edit_selection" as const,
  documentTitle: "r-docs",
  documentText: "Intro text",
  documentBlocks: [
    { type: "text" as const, text: "Intro text" },
    { type: "image" as const, src: "data:image/png;base64,abc", alt: "Pasted diagram" },
    {
      type: "repoImage" as const,
      src: "/api/documents/doc-1/repo-files?path=assets/accuracy.png",
      path: "assets/accuracy.png",
      alt: "Accuracy plot",
      caption: "Comparison"
    },
    {
      type: "widget" as const,
      widgetId: "widget-1",
      label: "Rollout explorer",
      buildCmd: "python widgets/build_rollout.py",
      embedSource: "assets/rollout.html",
      src: "/api/documents/doc-1/widgets/widget-1/source"
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

test("system prompt surfaces submit_response contract and document context", () => {
  const prompt = buildSystemPrompt(baseInput);

  assert.match(prompt, /submit_response/);
  assert.match(prompt, /Inline pasted image: alt=Pasted diagram/);
  assert.match(prompt, /Repository image: alt=Accuracy plot/);
  assert.match(prompt, /Interactive widget: label=Rollout explorer/);
  assert.match(prompt, /Thread thread-1/);
  assert.match(prompt, /assets\/accuracy\.png/);
});

test("structured repo image and widget metadata makes it into the prompt", () => {
  const blocks = getDocumentAiBlocks({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Results summary" }]
      },
      {
        type: "repoImage",
        attrs: {
          src: "/api/documents/doc-1/assets/accuracy.png",
          path: "assets/accuracy.png",
          alt: "Accuracy plot",
          caption: "Comparison"
        }
      },
      {
        type: "embeddedWidget",
        attrs: {
          widgetId: "widget-1",
          label: "Rollout explorer",
          buildCmd: "python widgets/build_rollout.py --output assets/rollout.html",
          embedSource: "assets/rollout.html",
          src: "/api/documents/doc-1/widgets/widget-1/source"
        }
      }
    ]
  });

  const prompt = buildSystemPrompt({
    ...baseInput,
    documentBlocks: blocks
  });

  assert.match(prompt, /path=assets\/accuracy\.png/);
  assert.match(prompt, /widget_id=widget-1/);
  assert.match(prompt, /build_cmd=python widgets\/build_rollout\.py --output assets\/rollout\.html/);
  assert.match(prompt, /embed_source=assets\/rollout\.html/);
});

test("edit user prompt instructs the agent to call submit_response", () => {
  const prompt = buildUserPrompt(baseInput);
  assert.match(prompt, /call submit_response with replacementText/);
});

test("edit user prompt prefers the markdown serialization of the selection when provided", () => {
  const promptWithoutMd = buildUserPrompt(baseInput);
  assert.match(promptWithoutMd, /Selected text:\nIntro text/);

  const promptWithMd = buildUserPrompt({
    ...baseInput,
    selectedMarkdown: "## Heading\n\n- a\n- b"
  });
  assert.match(promptWithMd, /Markdown serialization that preserves headings/);
  assert.match(promptWithMd, /## Heading/);
});

test("comment user prompt routes the reply through submit_response", () => {
  const prompt = buildUserPrompt({
    ...baseInput,
    mode: "comment_reply" as const,
    anchorText: "Intro text",
    anchorContext: "Intro text near the top",
    comments: [{ author: "Niels", body: "What should this say?" }]
  });

  assert.match(prompt, /comment request can only post a comment reply/);
  assert.match(prompt, /call submit_response with reply set to the comment text/);
  assert.match(prompt, /Anchor: Intro text/);
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
