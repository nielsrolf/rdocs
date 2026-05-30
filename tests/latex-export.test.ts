import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { collectDocumentImages, documentToLatex, escapeLatex } from "../lib/latex-export";

function hasPdflatex(): boolean {
  try {
    execFileSync("pdflatex", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("escapeLatex neutralises LaTeX special characters", () => {
  assert.equal(escapeLatex("100% & #1 of $x_2$"), "100\\% \\& \\#1 of \\$x\\_2\\$");
  assert.equal(escapeLatex("a\\b"), "a\\textbackslash{}b");
  assert.equal(escapeLatex("~^"), "\\textasciitilde{}\\textasciicircum{}");
});

test("documentToLatex renders structure, marks, and a title", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Intro" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "bold", marks: [{ type: "bold" }] },
          { type: "text", text: " and " },
          { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://example.com" } }] }
        ]
      },
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] }
        ]
      },
      { type: "codeBlock", content: [{ type: "text", text: "x = 1 % not a comment" }] }
    ]
  };
  const tex = documentToLatex(doc, { title: "My Paper" });
  assert.match(tex, /\\documentclass/);
  assert.match(tex, /\\title\{My Paper\}/);
  assert.match(tex, /\\section\{Intro\}/);
  assert.match(tex, /\\textbf\{bold\}/);
  assert.match(tex, /\\href\{https:\/\/example\.com\}\{link\}/);
  assert.match(tex, /\\begin\{itemize\}[\s\S]*\\item one[\s\S]*\\item two[\s\S]*\\end\{itemize\}/);
  // Code block content is verbatim — the % must NOT be escaped inside.
  assert.match(tex, /\\begin\{verbatim\}\nx = 1 % not a comment\n\\end\{verbatim\}/);
  assert.match(tex, /\\end\{document\}/);
});

test("collectDocumentImages dedupes and an embedded path is referenced", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "image", attrs: { src: "https://img/a.png", alt: "A" } },
      { type: "repoImage", attrs: { path: "figs/plot.png", caption: "Plot" } },
      { type: "image", attrs: { src: "https://img/a.png", alt: "A again" } }
    ]
  };
  const imgs = collectDocumentImages(doc);
  assert.equal(imgs.length, 2);
  assert.deepEqual(imgs.map((i) => i.key), ["image:https://img/a.png", "repo:figs/plot.png"]);

  const paths = new Map([["repo:figs/plot.png", "images/fig-1.png"]]);
  const tex = documentToLatex(doc, { title: "T", imagePaths: paths });
  // Resolved repo image is included; the unresolved http image becomes a placeholder.
  assert.match(tex, /\\includegraphics\[width=0\.8\\linewidth\]\{images\/fig-1\.png\}/);
  assert.match(tex, /Image not embedded/);
});

test("the generated LaTeX compiles with pdflatex when available", { skip: !hasPdflatex() }, () => {
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Section & Co." }] },
      { type: "paragraph", content: [{ type: "text", text: "Risky chars: 50% _under_ #1 {brace}" }] },
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quote" }] }] },
      { type: "codeBlock", content: [{ type: "text", text: "if x % 2 == 0: pass" }] },
      {
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "done" }] }] },
          { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "todo" }] }] }
        ]
      },
      { type: "image", attrs: { src: "https://example.com/missing.png", alt: "missing" } }
    ]
  };
  const tex = documentToLatex(doc, { title: "Compile Test 100%" });
  const dir = mkdtempSync(path.join(tmpdir(), "tex-"));
  try {
    writeFileSync(path.join(dir, "main.tex"), tex);
    execFileSync("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "main.tex"], {
      cwd: dir,
      stdio: "ignore"
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
