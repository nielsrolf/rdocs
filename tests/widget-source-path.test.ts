import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getWorkspacePath } from "../lib/research-workspace";
import { readEmbedSourceFromCandidates, tryReadEmbedSource } from "../lib/widget-source";

// Regression coverage for: "widgets would not appear in the document because of
// false paths of saved assets." The source route resolves a widget's
// embed_source from candidate workspaces; if the path logic looks in the wrong
// place (or the per-run worktree was garbage-collected after the merge), the
// widget renders blank.

async function makeWorkspaceWith(file: string | null, html: string) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "rdocs-widget-"));
  if (file) {
    await fs.mkdir(path.join(ws, path.dirname(file)), { recursive: true });
    await fs.writeFile(path.join(ws, file), html);
  }
  return ws;
}

test("serves the asset from the base workspace", async () => {
  const base = await makeWorkspaceWith("assets/w.html", "<h1>base</h1>");
  try {
    const html = await readEmbedSourceFromCandidates([base, null], "assets/w.html");
    assert.equal(html, "<h1>base</h1>");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("falls back to the run worktree when the base lacks the asset", async () => {
  const base = await makeWorkspaceWith(null, "");
  const worktree = await makeWorkspaceWith("assets/w.html", "<h1>worktree</h1>");
  try {
    const html = await readEmbedSourceFromCandidates([base, worktree], "assets/w.html");
    assert.equal(html, "<h1>worktree</h1>");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(worktree, { recursive: true, force: true });
  }
});

test("base workspace wins over worktree when both have the asset (post-merge home)", async () => {
  const base = await makeWorkspaceWith("assets/w.html", "<h1>base</h1>");
  const worktree = await makeWorkspaceWith("assets/w.html", "<h1>worktree</h1>");
  try {
    const html = await readEmbedSourceFromCandidates([base, worktree], "assets/w.html");
    assert.equal(html, "<h1>base</h1>");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(worktree, { recursive: true, force: true });
  }
});

test("survives a garbage-collected worktree (null candidate) by serving from base", async () => {
  // Mirrors Phase-1 worktree GC: widget.workspacePath points at a removed dir.
  const base = await makeWorkspaceWith("assets/w.html", "<h1>base</h1>");
  const removedWorktree = path.join(os.tmpdir(), "rdocs-widget-removed-does-not-exist");
  try {
    const html = await readEmbedSourceFromCandidates([base, removedWorktree], "assets/w.html");
    assert.equal(html, "<h1>base</h1>");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("returns null when the asset is absent everywhere (renders the not-found state)", async () => {
  const base = await makeWorkspaceWith(null, "");
  try {
    const html = await readEmbedSourceFromCandidates([base, null], "assets/missing.html");
    assert.equal(html, null);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("rejects an embed_source that escapes the workspace (path traversal)", async () => {
  const base = await makeWorkspaceWith("assets/w.html", "<h1>base</h1>");
  try {
    assert.equal(await tryReadEmbedSource(base, "../../../../etc/hosts"), null);
    assert.equal(await readEmbedSourceFromCandidates([base], "../../secret.html"), null);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("getWorkspacePath is deterministic per document+repo and differs across repos", () => {
  const a1 = getWorkspacePath("doc-1", "https://github.com/owner/repo");
  const a2 = getWorkspacePath("doc-1", "https://github.com/owner/repo");
  const b = getWorkspacePath("doc-1", "https://github.com/owner/other");
  const c = getWorkspacePath("doc-2", "https://github.com/owner/repo");
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.notEqual(a1, c);
  assert.ok(a1.includes("doc-1"));
});
