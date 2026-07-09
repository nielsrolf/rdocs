import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { db } from "../lib/db";
import { copyOwnerDefaultSkillsToDocument } from "../lib/document-skills";
import {
  getDocumentSkillDir,
  getUserSkillDir,
  parseSkillFrontmatter,
  prepareSkillUpload,
  sanitizeSkillName,
  sanitizeSkillRelativePath,
  syncSkillsIntoWorktree,
  writeSkillToStore,
  WORKTREE_SKILLS_DIRNAME
} from "../lib/skills";

const SKILL_MD = `---
name: data-viz
description: Chart and dashboard conventions for this team.
---

Use the palette in references/palette.md.
`;

test("sanitizeSkillName produces a slug usable as a directory and SDK skill name", () => {
  assert.equal(sanitizeSkillName("Data Viz!"), "data-viz");
  assert.equal(sanitizeSkillName("../../etc"), "etc");
  assert.equal(sanitizeSkillName("---"), "");
  assert.equal(sanitizeSkillName("A".repeat(100)).length <= 64, true);
});

test("sanitizeSkillRelativePath rejects traversal and absolute escapes", () => {
  assert.equal(sanitizeSkillRelativePath("references/palette.md"), "references/palette.md");
  assert.equal(sanitizeSkillRelativePath("skill\\win\\file.md"), "skill/win/file.md");
  assert.equal(sanitizeSkillRelativePath("../outside.md"), null);
  assert.equal(sanitizeSkillRelativePath("a/../../b.md"), null);
  assert.equal(sanitizeSkillRelativePath("/etc/passwd"), "etc/passwd");
  assert.equal(sanitizeSkillRelativePath(""), null);
  assert.equal(sanitizeSkillRelativePath("a/b/c/d/e/f/g/h/i.md"), null, "depth limit");
});

test("parseSkillFrontmatter reads name and description, tolerating quotes and missing frontmatter", () => {
  assert.deepEqual(parseSkillFrontmatter(SKILL_MD), {
    name: "data-viz",
    description: "Chart and dashboard conventions for this team."
  });
  assert.deepEqual(parseSkillFrontmatter('---\nname: "quoted"\n---\nbody'), {
    name: "quoted",
    description: null
  });
  assert.deepEqual(parseSkillFrontmatter("no frontmatter"), { name: null, description: null });
});

test("prepareSkillUpload strips the shared folder root and keys off SKILL.md frontmatter", () => {
  const prepared = prepareSkillUpload([
    { relativePath: "My Skill/SKILL.md", bytes: Buffer.from(SKILL_MD) },
    { relativePath: "My Skill/references/palette.md", bytes: Buffer.from("palette") }
  ]);
  assert.equal(prepared.name, "data-viz");
  assert.equal(prepared.description, "Chart and dashboard conventions for this team.");
  assert.deepEqual([...prepared.files.keys()].sort(), ["SKILL.md", "references/palette.md"]);
});

test("prepareSkillUpload falls back to the folder name when frontmatter has no name", () => {
  const prepared = prepareSkillUpload([
    { relativePath: "Deploy Notes/SKILL.md", bytes: Buffer.from("just a body") }
  ]);
  assert.equal(prepared.name, "deploy-notes");
});

test("prepareSkillUpload accepts a single markdown file as the SKILL.md", () => {
  const prepared = prepareSkillUpload([
    { relativePath: "my-skill.md", bytes: Buffer.from(SKILL_MD) }
  ]);
  assert.equal(prepared.name, "data-viz");
  assert.deepEqual([...prepared.files.keys()], ["SKILL.md"]);
});

test("prepareSkillUpload rejects uploads without a root SKILL.md", () => {
  assert.throws(
    () =>
      prepareSkillUpload([
        { relativePath: "folder/readme.md", bytes: Buffer.from("x") },
        { relativePath: "folder/other.txt", bytes: Buffer.from("y") }
      ]),
    /SKILL\.md/
  );
});

test("prepareSkillUpload rejects traversal paths instead of rewriting them", () => {
  assert.throws(
    () =>
      prepareSkillUpload([
        { relativePath: "skill/SKILL.md", bytes: Buffer.from(SKILL_MD) },
        { relativePath: "skill/../../../evil.sh", bytes: Buffer.from("rm -rf") }
      ]),
    /Invalid file path/
  );
});

test("writeSkillToStore + syncSkillsIntoWorktree materialize skills under .claude/skills with a self-ignoring .gitignore", async (t) => {
  const documentId = `test-skills-${process.pid}-${Date.now()}`;
  const workspaceRoot = path.join(process.cwd(), ".research-workspaces");
  t.after(async () => {
    await fs.rm(path.join(workspaceRoot, documentId), { recursive: true, force: true });
  });

  const prepared = prepareSkillUpload([
    { relativePath: "data-viz/SKILL.md", bytes: Buffer.from(SKILL_MD) },
    { relativePath: "data-viz/references/palette.md", bytes: Buffer.from("palette") }
  ]);
  await writeSkillToStore(getDocumentSkillDir(documentId, prepared.name), prepared);

  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "wt-skills-"));
  t.after(async () => {
    await fs.rm(worktree, { recursive: true, force: true });
  });
  spawnSync("git", ["init", "-q"], { cwd: worktree });
  spawnSync("git", ["config", "user.email", "t@t.local"], { cwd: worktree });
  spawnSync("git", ["config", "user.name", "t"], { cwd: worktree });

  await syncSkillsIntoWorktree(documentId, worktree);

  const skillMd = await fs.readFile(
    path.join(worktree, WORKTREE_SKILLS_DIRNAME, "data-viz", "SKILL.md"),
    "utf8"
  );
  assert.match(skillMd, /name: data-viz/);
  const nested = await fs.readFile(
    path.join(worktree, WORKTREE_SKILLS_DIRNAME, "data-viz", "references", "palette.md"),
    "utf8"
  );
  assert.equal(nested, "palette");

  const status = spawnSync("git", ["status", "--porcelain"], { cwd: worktree });
  assert.equal(status.stdout.toString().trim(), "", "materialized skills must not show up as git changes");
});

test("syncSkillsIntoWorktree is a no-op for documents without skills", async (t) => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "wt-noskills-"));
  t.after(async () => {
    await fs.rm(worktree, { recursive: true, force: true });
  });
  await syncSkillsIntoWorktree(`missing-${crypto.randomUUID()}`, worktree);
  const exists = await fs
    .stat(path.join(worktree, ".claude"))
    .then(() => true)
    .catch(() => false);
  assert.equal(exists, false);
});

test("copyOwnerDefaultSkillsToDocument copies only default skills (files + rows)", async (t) => {
  const user = await db.user.create({
    data: { email: `skills-${crypto.randomUUID()}@example.com`, name: "skills-user", passwordHash: "x" }
  });
  const document = await db.document.create({
    data: { title: "Skills test doc", content: '{"type":"doc","content":[]}', ownerId: user.id }
  });
  t.after(async () => {
    await db.document.delete({ where: { id: document.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await fs.rm(path.join(process.cwd(), ".user-skills", user.id), { recursive: true, force: true });
    await fs.rm(path.join(process.cwd(), ".research-workspaces", document.id), {
      recursive: true,
      force: true
    });
  });

  for (const [name, isDefault] of [
    ["default-skill", true],
    ["optional-skill", false]
  ] as const) {
    const prepared = prepareSkillUpload([
      {
        relativePath: `${name}/SKILL.md`,
        bytes: Buffer.from(`---\nname: ${name}\ndescription: ${name} description\n---\nbody`)
      }
    ]);
    await writeSkillToStore(getUserSkillDir(user.id, prepared.name), prepared);
    await db.userSkill.create({
      data: { userId: user.id, name: prepared.name, description: prepared.description, isDefault }
    });
  }

  await copyOwnerDefaultSkillsToDocument(user.id, document.id);

  const docSkills = await db.documentSkill.findMany({ where: { documentId: document.id } });
  assert.deepEqual(
    docSkills.map((skill) => skill.name),
    ["default-skill"]
  );
  assert.equal(docSkills[0].description, "default-skill description");
  assert.equal(docSkills[0].createdById, user.id);

  const copiedSkillMd = await fs.readFile(
    path.join(getDocumentSkillDir(document.id, "default-skill"), "SKILL.md"),
    "utf8"
  );
  assert.match(copiedSkillMd, /default-skill description/);
  const optionalCopied = await fs
    .stat(getDocumentSkillDir(document.id, "optional-skill"))
    .then(() => true)
    .catch(() => false);
  assert.equal(optionalCopied, false);
});
