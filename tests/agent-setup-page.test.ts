import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsx compiles the component's JSX to React.createElement (the tsconfig says
// "preserve", which Next handles itself), so React has to be in scope here.
(globalThis as { React?: typeof React }).React = React;
const component = async () => (await import("../app/agent-setup/agent-setup-client")).AgentSetupClient;

// A render smoke test: the consent page is only reachable signed in, from an
// integration's one-time link, so nothing else exercises its markup.
test("the consent page offers presets, scaffold and model, skills, keys and a budget with a cost project", async () => {
  const html = renderToStaticMarkup(
    createElement(await component(), {
      manifestUrl: "https://backlog.example.com/api/rdocs/manifest/r1",
      credentialChoices: [
        { id: "anthropic", label: "Claude subscription", envNames: ["CLAUDE_CODE_OAUTH_TOKEN"], model: true },
        { id: "github", label: "GitHub token", envNames: ["GITHUB_TOKEN"], model: false }
      ],
      budgetProvisioners: [{ id: "doc1", title: "Compute account" }],
      presets: [
        {
          id: "p1",
          name: "Careful Opus, $50",
          config: {
            agentModel: "claude-opus-latest",
            agentEffort: "high",
            skills: ["tinker"],
            credentialIds: ["github"],
            budget: { provisionerDocumentId: "doc1", budgetUsd: 50, costProjectParent: "srf" }
          }
        }
      ],
      librarySkills: [
        { name: "tinker", description: "Reference guide for the Tinker training API" },
        { name: "vibes-eval", description: null }
      ],
      defaults: { model: "codex/openai/gpt-5.6-terra", effort: "medium" }
    })
  );
  for (const expected of [
    "Careful Opus, $50",                      // the preset to pick
    "My default (Codex, GPT-5.6 Terra)",      // what leaving the scaffold alone means
    ">Claude Code<", ">Codex<",               // the scaffolds
    "My default (Medium)",                    // thinking
    "tinker", "Reference guide for the Tinker training API", "vibes-eval",
    "Claude subscription", "GitHub token",
    "Compute account", "No budget",
    "Save as preset"
  ]) {
    assert.ok(html.includes(expected), `missing: ${expected}`);
  }
  // nothing is preselected that the user did not choose: no skill ticked, no budget, the model key ticked as before
  assert.equal((html.match(/type="checkbox" checked=""/g) ?? []).length, 1);
  assert.ok(!html.includes("Budget (USD)"), "budget fields appear only once a paying document is picked");
});

test("without presets, skills or a document to pay, those parts stay out of the way", async () => {
  const html = renderToStaticMarkup(createElement(await component(), { manifestUrl: "https://x.example.com/m", credentialChoices: null }));
  assert.ok(html.includes("None yet: configure below and save one"));
  assert.ok(html.includes("Skills in your library (Settings → AI) can be added here."));
  assert.ok(!html.includes("Compute budget"));
  assert.ok(!html.includes("Keys this agent may use"));
});
