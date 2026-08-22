import assert from "node:assert/strict";
import { test } from "node:test";

import { EditorState } from "@tiptap/pm/state";

import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import { flattenDocumentAnchorText } from "../lib/suggestion-content";
import { findAnchorMatch } from "../agent-core/anchor-text";
import { validateSuggestions, validateAgentComments } from "../lib/ai-edit-submission";
import { resolveSuggestionRange } from "../components/document-workspace/ai-suggestions";

// Regression suite for the 2026-08-19 incident: a Codex run burned all 4
// submission attempts because every findText it copied faithfully from the
// prompt (which renders blocks separated by newlines, and markdown links as
// [text](url)) could never match the separator-less flattened text-node basis
// the validator checked against. Three fixes are covered here:
//   1. the anchor basis includes newline separators between blocks, and the
//      matcher tolerates newline/whitespace differences and markdown syntax;
//   2. server validation and client resolution stay in lockstep on that basis;
//   3. a submission with several broken anchors reports ALL of them at once.

const schema = createDocumentEditorSchema();

function stateFrom(json: unknown) {
  return EditorState.create({ doc: schema.nodeFromJSON(json) });
}

// A document shaped like the incident's: bullet list items + a markdown link
// rendered in the doc as plain link text.
const DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Research code" }]
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Avoid duplicating information between comments, markdown files, and the doc. In your project-specific " },
                { type: "text", marks: [{ type: "link", attrs: { href: "https://CLAUDE.md" } }], text: "CLAUDE.md" },
                { type: "text", text: " file, be clear on which info lives where." }
              ]
            }
          ]
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Use a folder with experiments like this" }]
            }
          ]
        }
      ]
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "Trailing paragraph." }]
    }
  ]
};

// ---------------------------------------------------------------------------
// flattenDocumentAnchorText: the shared validation/resolution basis
// ---------------------------------------------------------------------------

test("flattenDocumentAnchorText separates blocks with newlines and renders hardBreak as newline", () => {
  const content = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Hello " }, { type: "text", marks: [{ type: "bold" }], text: "world" }] },
      { type: "paragraph", content: [{ type: "text", text: "Line one" }, { type: "hardBreak" }, { type: "text", text: "Line two" }] }
    ]
  };
  assert.equal(flattenDocumentAnchorText(content), "Hello world\nLine one\nLine two");
});

// ---------------------------------------------------------------------------
// findAnchorMatch: tiered tolerant matcher
// ---------------------------------------------------------------------------

test("findAnchorMatch tier 1: exact substring", () => {
  const match = findAnchorMatch("The quick brown fox", "quick brown");
  assert.equal(match.count, 1);
  assert.equal("The quick brown fox".slice(match.start, match.end), "quick brown");
});

test("findAnchorMatch tier 2: tolerates newline/whitespace run differences", () => {
  const haystack = "item one\nitem two\nitem three";
  // The prompt's plain-text view can render blank lines between blocks.
  const match = findAnchorMatch(haystack, "item one\n\nitem two");
  assert.equal(match.count, 1);
  assert.equal(haystack.slice(match.start, match.end), "item one\nitem two");
});

test("findAnchorMatch tier 3: tolerates markdown link syntax and escapes in the needle", () => {
  const haystack = "In your project-specific CLAUDE.md file, be clear.";
  const match = findAnchorMatch(haystack, "In your project-specific [CLAUDE.md](https://CLAUDE.md) file, be clear\\.");
  assert.equal(match.count, 1);
  assert.equal(haystack.slice(match.start, match.end), "In your project-specific CLAUDE.md file, be clear.");
});

test("findAnchorMatch enforces uniqueness within the matching tier", () => {
  assert.equal(findAnchorMatch("a b a b", "a b").count, 2);
  assert.equal(findAnchorMatch("x\ny x\ny", "x\n\ny").count, 2);
});

test("findAnchorMatch returns no match for absent text", () => {
  assert.equal(findAnchorMatch("some document text", "elephant").count, 0);
});

// ---------------------------------------------------------------------------
// Incident repro: server validation accepts what the model copied verbatim
// ---------------------------------------------------------------------------

test("regression: a findText with markdown link syntax (as shown by read_document) validates", () => {
  const anchorText = flattenDocumentAnchorText(DOC);
  const error = validateSuggestions(
    [
      {
        findText:
          "Avoid duplicating information between comments, markdown files, and the doc. In your project-specific [CLAUDE.md](https://CLAUDE.md) file",
        replacementText: "rewritten"
      }
    ],
    anchorText
  );
  assert.equal(error, null);
});

test("regression: a findText spanning list items (as shown in the prompt's plain-text view) validates", () => {
  const anchorText = flattenDocumentAnchorText(DOC);
  const error = validateSuggestions(
    [
      {
        findText: "which info lives where.\nUse a folder with experiments like this",
        replacementText: "rewritten"
      }
    ],
    anchorText
  );
  assert.equal(error, null);
});

// ---------------------------------------------------------------------------
// Lockstep: what passes server validation resolves to ONE range on the client
// ---------------------------------------------------------------------------

test("lockstep: tolerant anchors resolve on the client to the matched document range", () => {
  const state = stateFrom(DOC);

  const linkNeedle =
    "In your project-specific [CLAUDE.md](https://CLAUDE.md) file, be clear on which info lives where\\.";
  const linkRange = resolveSuggestionRange(state.doc, linkNeedle);
  assert.ok(linkRange, "markdown-syntax needle resolves");
  assert.equal(
    state.doc.textBetween(linkRange!.from, linkRange!.to),
    "In your project-specific CLAUDE.md file, be clear on which info lives where."
  );

  const multiBlockNeedle = "which info lives where.\nUse a folder with experiments like this";
  const blockRange = resolveSuggestionRange(state.doc, multiBlockNeedle);
  assert.ok(blockRange, "multi-block needle resolves");
  assert.equal(
    state.doc.textBetween(blockRange!.from, blockRange!.to, "\n"),
    "which info lives where.\nUse a folder with experiments like this"
  );
});

test("lockstep: exact single-block anchors still validate and resolve unchanged", () => {
  const anchorText = flattenDocumentAnchorText(DOC);
  const suggestion = { findText: "Trailing paragraph.", replacementText: "The end." };
  assert.equal(validateSuggestions([suggestion], anchorText), null);
  const state = stateFrom(DOC);
  const range = resolveSuggestionRange(state.doc, suggestion.findText);
  assert.ok(range);
  assert.equal(state.doc.textBetween(range!.from, range!.to), "Trailing paragraph.");
});

test("client still rejects ambiguous anchors", () => {
  const state = stateFrom({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "same phrase" }] },
      { type: "paragraph", content: [{ type: "text", text: "same phrase" }] }
    ]
  });
  assert.equal(resolveSuggestionRange(state.doc, "same phrase"), null);
});

// ---------------------------------------------------------------------------
// Batch error reporting: all broken anchors in ONE rejection
// ---------------------------------------------------------------------------

test("validateSuggestions reports every failing suggestion in a single rejection", () => {
  const anchorText = flattenDocumentAnchorText(DOC);
  const error = validateSuggestions(
    [
      { findText: "Trailing paragraph.", replacementText: "ok" },
      { findText: "totally absent phrase one", replacementText: "x" },
      { findText: "totally absent phrase two", replacementText: "y" }
    ],
    anchorText
  );
  assert.ok(error, "invalid suggestions are rejected");
  assert.ok(error!.includes("Suggestion #2"), "first failure reported");
  assert.ok(error!.includes("Suggestion #3"), "second failure reported in the SAME rejection");
});

test("validateAgentComments reports every failing comment in a single rejection", () => {
  const anchorText = flattenDocumentAnchorText(DOC);
  const error = validateAgentComments(
    [
      { findText: "absent anchor A", body: "note" },
      { findText: "absent anchor B", body: "note" }
    ],
    anchorText
  );
  assert.ok(error);
  assert.ok(error!.includes("Comment #1"));
  assert.ok(error!.includes("Comment #2"));
});

// ---------------------------------------------------------------------------
// Error message guidance points at the real matching basis
// ---------------------------------------------------------------------------

test("the not-found rejection explains the plain-text basis instead of demanding verbatim copying", () => {
  const error = validateSuggestions(
    [{ findText: "absent", replacementText: "x" }],
    "some document text"
  );
  assert.ok(error);
  assert.ok(/plain text/i.test(error!), `message should mention the plain-text basis, got: ${error}`);
});
