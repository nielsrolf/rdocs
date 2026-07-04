import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectEditAssetIntent } from "../lib/ai-asset-intent";
import {
  buildRepoFileUrl,
  embedSourceExists,
  hasMarkdownImage,
  normalizeAgentImages,
  normalizeSubmittedWidget,
  validateAiEditAssets
} from "../lib/ai-edit-submission";

// Regression coverage for: "AI edits would fail", "AI edits sometimes failed to
// update the content", and "errors that were supposed to be reported to the AI
// were reported to the user". validateAiEditAssets returns an error STRING that
// the route hands back to the agent (so it can retry) — it must NEVER throw,
// because a throw is what surfaces to the human user.

const NO_INTENT = { requiresAnyAsset: false, requiresImage: false, requiresWidget: false };

test("detectEditAssetIntent classifies image / widget / either / none", () => {
  assert.deepEqual(
    { ...detectEditAssetIntent("Please add a plot of the results") },
    {
      wantsImage: true,
      wantsWidget: false,
      acceptsEitherAsset: false,
      requiresImage: true,
      requiresWidget: false,
      requiresAnyAsset: false
    }
  );

  const widget = detectEditAssetIntent("Build an interactive widget for this");
  assert.equal(widget.requiresWidget, true);
  assert.equal(widget.requiresImage, false);

  const either = detectEditAssetIntent("Add a figure or widget here");
  assert.equal(either.requiresAnyAsset, true);
  assert.equal(either.requiresImage, false);
  assert.equal(either.requiresWidget, false);

  const none = detectEditAssetIntent("Rewrite this paragraph for clarity");
  assert.equal(none.requiresImage, false);
  assert.equal(none.requiresWidget, false);
  assert.equal(none.requiresAnyAsset, false);
});

test("detectEditAssetIntent treats an interactive-qualified plot as a widget, not both assets", () => {
  // Regression for run cmql1ijho01lt13dd2vksjdrr: "Can you add interactive plots
  // that visualize our spending?" was parsed as requiresImage && requiresWidget,
  // so the agent's valid Plotly widget was rejected for lacking a static image,
  // and it timed out generating one. "interactive <plot/chart/visual>" is a
  // single interactive visualization — a widget, not a widget plus an image.
  for (const instruction of [
    "Can you add interactive plots that visualize our spending?",
    "Add an interactive chart of revenue over time",
    "make this an interactive visualization"
  ]) {
    const intent = detectEditAssetIntent(instruction);
    assert.equal(intent.requiresWidget, true, instruction);
    assert.equal(intent.requiresImage, false, instruction);
    assert.equal(intent.requiresAnyAsset, false, instruction);
  }

  // A bare "plot"/"figure" with no interactive qualifier is still an image.
  const plot = detectEditAssetIntent("Add a plot of the results");
  assert.equal(plot.requiresImage, true);
  assert.equal(plot.requiresWidget, false);
});

test("validateAiEditAssets rejects an empty submission with a retry message", () => {
  const error = validateAiEditAssets({
    replacementText: "",
    selectedText: "the original",
    hasImage: false,
    hasWidget: false,
    assetIntent: NO_INTENT
  });
  assert.ok(error && /no replacementText/i.test(error));
});

test("validateAiEditAssets rejects a no-op (replacement identical to selection)", () => {
  const error = validateAiEditAssets({
    replacementText: "  the original  ",
    selectedText: "the original",
    hasImage: false,
    hasWidget: false,
    assetIntent: NO_INTENT
  });
  assert.ok(error && /identical/i.test(error));
});

test("validateAiEditAssets enforces required image / widget / either", () => {
  const imageMissing = validateAiEditAssets({
    replacementText: "new text",
    selectedText: "old",
    hasImage: false,
    hasWidget: false,
    assetIntent: { requiresAnyAsset: false, requiresImage: true, requiresWidget: false }
  });
  assert.ok(imageMissing && /figure or visual/i.test(imageMissing));

  const widgetMissing = validateAiEditAssets({
    replacementText: "new text",
    selectedText: "old",
    hasImage: false,
    hasWidget: false,
    assetIntent: { requiresAnyAsset: false, requiresImage: false, requiresWidget: true }
  });
  assert.ok(widgetMissing && /interactive widget/i.test(widgetMissing));

  const eitherMissing = validateAiEditAssets({
    replacementText: "new text",
    selectedText: "old",
    hasImage: false,
    hasWidget: false,
    assetIntent: { requiresAnyAsset: true, requiresImage: false, requiresWidget: false }
  });
  assert.ok(eitherMissing && /figure or widget/i.test(eitherMissing));

  // Satisfying the requirement clears the error.
  assert.equal(
    validateAiEditAssets({
      replacementText: "new text",
      selectedText: "old",
      hasImage: true,
      hasWidget: false,
      assetIntent: { requiresAnyAsset: true, requiresImage: false, requiresWidget: false }
    }),
    null
  );
});

test("validateAiEditAssets accepts a genuine edit and NEVER throws", () => {
  assert.equal(
    validateAiEditAssets({
      replacementText: "A meaningfully rewritten paragraph.",
      selectedText: "old paragraph",
      hasImage: false,
      hasWidget: false,
      assetIntent: NO_INTENT
    }),
    null
  );

  // Defensive: weird inputs return a string or null, never throw.
  assert.doesNotThrow(() =>
    validateAiEditAssets({
      replacementText: undefined,
      selectedText: "",
      hasImage: false,
      hasWidget: false,
      assetIntent: NO_INTENT
    })
  );
});

test("hasMarkdownImage detects inline figures (counts as an image asset)", () => {
  assert.equal(hasMarkdownImage("see ![A plot](assets/plot.png) above"), true);
  assert.equal(hasMarkdownImage("just a [link](https://x.com) not an image"), false);
});

test("normalizeSubmittedWidget accepts snake_case and camelCase, rejects incomplete", () => {
  assert.deepEqual(
    normalizeSubmittedWidget({ label: "FFT", build_cmd: "python w.py", embed_source: "assets/w.html" }),
    { label: "FFT", buildCmd: "python w.py", embedSource: "assets/w.html" }
  );
  assert.deepEqual(
    normalizeSubmittedWidget({ buildCmd: "node b.js", embedSource: "assets/o.html" }),
    { label: "Interactive widget", buildCmd: "node b.js", embedSource: "assets/o.html" }
  );
  assert.equal(normalizeSubmittedWidget({ label: "x", embed_source: "a.html" }), null); // no build cmd
  assert.equal(normalizeSubmittedWidget(null), null);
});

test("normalizeAgentImages builds repo-file URLs and filters invalid entries", () => {
  const images = normalizeAgentImages(
    [
      { path: "assets/plot.png", alt: "A plot" },
      { path: "  " }, // blank => dropped
      "nonsense", // not an object => dropped
      { path: "assets/two.svg" }
    ],
    "doc123",
    "share-tok",
    "run-xyz"
  );
  assert.equal(images.length, 2);
  assert.equal(images[0].path, "assets/plot.png");
  assert.match(images[0].src, /\/api\/documents\/doc123\/repo-files\?/);
  assert.match(images[0].src, /path=assets%2Fplot\.png/);
  assert.match(images[0].src, /share=share-tok/);
  assert.match(images[0].src, /run=run-xyz/);
  assert.equal(images[0].alt, "A plot");
  assert.equal(images[1].alt, "assets/two.svg"); // alt defaults to path
});

test("buildRepoFileUrl omits share/run params when absent", () => {
  const url = buildRepoFileUrl("doc1", "assets/x.png", null, null);
  assert.match(url, /^\/api\/documents\/doc1\/repo-files\?path=assets%2Fx\.png$/);
});

test("embedSourceExists: true for a real file inside the workspace, false for missing / traversal", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "rdocs-ws-"));
  try {
    await fs.mkdir(path.join(workspace, "assets"), { recursive: true });
    await fs.writeFile(path.join(workspace, "assets", "widget.html"), "<html></html>");

    assert.equal(await embedSourceExists(workspace, "assets/widget.html"), true);
    assert.equal(await embedSourceExists(workspace, "assets/missing.html"), false);
    // Path traversal must be rejected even if such a file exists outside.
    assert.equal(await embedSourceExists(workspace, "../../../../etc/hosts"), false);
    // A directory is not a file.
    assert.equal(await embedSourceExists(workspace, "assets"), false);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
