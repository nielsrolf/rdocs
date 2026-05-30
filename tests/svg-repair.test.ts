import assert from "node:assert/strict";
import { test } from "node:test";

import { repairSvgMarkup } from "../lib/svg-repair";

// Reproduces the real failure from document cmpo39xr00043erjj391n1h5s: the agent
// generated the sine-plot SVG with a Python script whose string literals used the
// shell-history-escape habit `\!`. Python keeps an invalid escape verbatim (with a
// SyntaxWarning), so every `<!-- ... -->` comment landed in the file as `<\!-- ... -->`.
// `<\!` is not well-formed XML, so a browser asked to render the file as
// image/svg+xml aborts parsing and shows only the <img> alt text — no plot.
const CORRUPTED_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300">',
  "  <\\!-- Border -->",
  '  <rect x="40" y="40" width="520" height="220" fill="#f8f9fa"/>',
  "  <\\!-- Grid lines -->",
  '  <line x1="40" y1="40" x2="40" y2="260" stroke="#dee2e6"/>',
  "  <\\!-- Sine curve -->",
  '  <polyline points="40,150 560,158" fill="none" stroke="#4c6ef5"/>',
  "</svg>",
  "",
].join("\n");

function isWellFormedXml(input: string): boolean {
  // Minimal well-formedness probe: the `<\!` artifact is the only thing that makes
  // the real file unparseable, and a parser rejects any standalone `<\` token.
  return !/<\\/.test(input);
}

test("corrupted fixture really is broken (guards the repro)", () => {
  assert.ok(CORRUPTED_SVG.includes("<\\!--"), "fixture must contain the escaped comment marker");
  assert.equal(isWellFormedXml(CORRUPTED_SVG), false);
});

test("repairs shell/python over-escaped comment markers so the SVG renders", () => {
  const repaired = repairSvgMarkup(CORRUPTED_SVG);
  assert.ok(!repaired.includes("<\\!"), "no escaped markup may remain");
  assert.ok(repaired.includes("<!-- Border -->"), "comment markers are restored");
  assert.ok(repaired.includes("<!-- Sine curve -->"));
  assert.equal(isWellFormedXml(repaired), true);
});

test("leaves a well-formed SVG untouched and is idempotent", () => {
  const clean = '<svg xmlns="http://www.w3.org/2000/svg"><!-- ok --><rect/></svg>';
  assert.equal(repairSvgMarkup(clean), clean);
  const once = repairSvgMarkup(CORRUPTED_SVG);
  assert.equal(repairSvgMarkup(once), once);
});

test("does not touch a legitimate backslash inside text content", () => {
  // A backslash that is not opening markup (`<\`) must survive — only `<\` is repaired.
  const withText = '<svg><text>path C:\\\\Users\\\\me</text><!-- c --></svg>';
  assert.equal(repairSvgMarkup(withText), withText);
});
