import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemPrompt, buildUserPrompt } from "../lib/ai";

// Returns the indices of any unpaired UTF-16 surrogate code units in `s`.
// A lone surrogate makes a string un-encodable as valid JSON, which is what
// the Claude Agent SDK does to build its request body — Anthropic then rejects
// it with `400 ... invalid high surrogate in string`.
function loneSurrogateIndices(s: string) {
  const hits: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isHigh = c >= 0xd800 && c <= 0xdbff;
    const isLow = c >= 0xdc00 && c <= 0xdfff;
    if (isHigh) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // valid pair
      } else {
        hits.push(i);
      }
    } else if (isLow) {
      hits.push(i);
    }
  }
  return hits;
}

const baseInput = {
  mode: "edit_selection" as const,
  documentTitle: "Untitled document",
  documentText: "Intro text",
  documentBlocks: [{ type: "text" as const, text: "Intro text" }],
  unresolvedThreads: [],
  workspacePath: null,
  workspaceOverview: "",
  instruction: "kannst du das raussuchen?",
  selectedText: "Intro text",
  selectedContext: "Intro text near the top"
};

// Reproduces the real failure: the selection-context window can land between
// the two code units of an emoji (e.g. 🏛 = U+1F3DB = 🏛), leaving a
// lone surrogate in selectedContext that flows straight into the agent prompt.
const SLICED_EMOJI_TAIL = "context ending mid-emoji \ud83c"; // lone high surrogate
const SLICED_EMOJI_HEAD = "\udfdb context starting mid-emoji"; // lone low surrogate

test("user prompt never carries a lone surrogate from a sliced emoji in the context", () => {
  const prompt = buildUserPrompt({ ...baseInput, selectedContext: SLICED_EMOJI_TAIL });
  assert.deepEqual(loneSurrogateIndices(prompt), []);
});

test("user prompt never carries a lone surrogate from a sliced emoji in the selected text", () => {
  const prompt = buildUserPrompt({ ...baseInput, selectedText: SLICED_EMOJI_HEAD, selectedMarkdown: null });
  assert.deepEqual(loneSurrogateIndices(prompt), []);
});

test("user prompt never carries a lone surrogate from a sliced emoji in the selected markdown", () => {
  const prompt = buildUserPrompt({ ...baseInput, selectedMarkdown: SLICED_EMOJI_TAIL });
  assert.deepEqual(loneSurrogateIndices(prompt), []);
});

test("system prompt never carries a lone surrogate from a sliced emoji in the document text", () => {
  const prompt = buildSystemPrompt({
    ...baseInput,
    documentText: SLICED_EMOJI_TAIL,
    documentBlocks: [{ type: "text" as const, text: SLICED_EMOJI_TAIL }]
  });
  assert.deepEqual(loneSurrogateIndices(prompt), []);
});

test("intact emoji surrogate pairs are preserved unchanged", () => {
  const prompt = buildUserPrompt({ ...baseInput, selectedContext: "museum 🏛 broccoli 🥦" });
  assert.deepEqual(loneSurrogateIndices(prompt), []);
  assert.match(prompt, /museum 🏛 broccoli 🥦/);
});
