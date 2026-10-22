import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installCatalogSkillOnDocument,
  syncDocumentSkillsForRun
} from "../lib/catalog-skills";
import { db } from "../lib/db";
import { expireCatalogCacheForTests, listCatalogSkills, loadCatalogSkill } from "../lib/skill-catalog";
import { getDocumentSkillDir, prepareSkillUpload, writeSkillToStore } from "../lib/skills";

// The catalog is a git repo of skill folders. `git clone` accepts local paths,
// so a fixture repo + SKILL_CATALOG_GIT_URL exercises the real clone path
// without the network.
async function makeFixtureCatalogRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-catalog-fixture-"));
  await fs.mkdir(path.join(dir, "tinker", "references"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "tinker", "SKILL.md"),
    `---\nname: tinker\ndescription: Fine-tune models with the Tinker API.\n---\n\nBody.\n`
  );
  await fs.writeFile(path.join(dir, "tinker", "references", "api.md"), "reference\n");
  await fs.mkdir(path.join(dir, "openweights"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "openweights", "SKILL.md"),
    `---\nname: openweights\ndescription: Run GPU workloads on managed RunPod infra.\n---\n\nBody.\n`
  );
  // A non-skill dir (no SKILL.md) must be ignored.
  await fs.mkdir(path.join(dir, "not-a-skill"), { recursive: true });
  await fs.writeFile(path.join(dir, "not-a-skill", "README.md"), "nope\n");
  for (const args of [
    ["init", "--quiet"],
    ["add", "-A"],
    ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "fixture"]
  ]) {
    const result = spawnSync("git", args, { cwd: dir });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return dir;
}

test("skill catalog lists skills and loads one for install", async () => {
  const fixture = await makeFixtureCatalogRepo();
  const previous = process.env.SKILL_CATALOG_GIT_URL;
  process.env.SKILL_CATALOG_GIT_URL = fixture;
  try {
    const skills = await listCatalogSkills();
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["openweights", "tinker"]
    );
    assert.equal(skills[1].description, "Fine-tune models with the Tinker API.");
    assert.equal(
      skills.some((skill) => skill.name === "not-a-skill"),
      false,
      "dirs without SKILL.md are not skills"
    );

    const prepared = await loadCatalogSkill("tinker");
    assert.ok(prepared);
    assert.equal(prepared.name, "tinker");
    assert.equal(prepared.description, "Fine-tune models with the Tinker API.");
    assert.ok(prepared.files.has("SKILL.md"));
    assert.ok(prepared.files.has("references/api.md"));

    assert.equal(await loadCatalogSkill("does-not-exist"), null);
    // Traversal-ish names sanitize to a slug and simply miss the catalog.
    assert.equal(await loadCatalogSkill("../../etc"), null);
  } finally {
    if (previous === undefined) delete process.env.SKILL_CATALOG_GIT_URL;
    else process.env.SKILL_CATALOG_GIT_URL = previous;
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

// Catalog-installed skills follow the catalog: a push to the catalog repo
// reaches the next run without anyone reinstalling, while a skill the user
// uploaded under the same name is never overwritten.
test("catalog-installed document skills are refreshed from the catalog at run start", async (t) => {
  const fixture = await makeFixtureCatalogRepo();
  const previous = process.env.SKILL_CATALOG_GIT_URL;
  process.env.SKILL_CATALOG_GIT_URL = fixture;
  const user = await db.user.create({
    data: { email: `catalog-${crypto.randomUUID()}@example.com`, name: "catalog-user", passwordHash: "x" }
  });
  const document = await db.document.create({
    data: { title: "Catalog refresh doc", content: '{"type":"doc","content":[]}', ownerId: user.id }
  });
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-refresh-worktree-"));
  t.after(async () => {
    if (previous === undefined) delete process.env.SKILL_CATALOG_GIT_URL;
    else process.env.SKILL_CATALOG_GIT_URL = previous;
    await db.document.delete({ where: { id: document.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await fs.rm(path.join(process.cwd(), ".research-workspaces", document.id), { recursive: true, force: true });
    await fs.rm(fixture, { recursive: true, force: true });
    await fs.rm(worktree, { recursive: true, force: true });
  });

  await installCatalogSkillOnDocument(document.id, "tinker", user.id);
  // A same-named user upload: not catalog-tracked, so never refreshed.
  const uploaded = prepareSkillUpload([
    { relativePath: "openweights/SKILL.md", bytes: Buffer.from("---\nname: openweights\ndescription: Mine.\n---\n\nMy own version.\n") }
  ]);
  await writeSkillToStore(getDocumentSkillDir(document.id, uploaded.name), uploaded);
  await db.documentSkill.create({
    data: { documentId: document.id, name: uploaded.name, description: uploaded.description, createdById: user.id }
  });

  // The catalog moves on after the install.
  await fs.writeFile(
    path.join(fixture, "tinker", "SKILL.md"),
    `---\nname: tinker\ndescription: Tinker, second edition.\n---\n\nNew body.\n`
  );
  await fs.rm(path.join(fixture, "tinker", "references"), { recursive: true });
  await fs.writeFile(
    path.join(fixture, "openweights", "SKILL.md"),
    `---\nname: openweights\ndescription: Catalog version.\n---\n\nCatalog body.\n`
  );
  git(fixture, ["add", "-A"]);
  git(fixture, ["commit", "--quiet", "-m", "update"]);
  await expireCatalogCacheForTests();

  await syncDocumentSkillsForRun(document.id, worktree);

  const tinkerMd = await fs.readFile(path.join(worktree, ".claude", "skills", "tinker", "SKILL.md"), "utf8");
  assert.match(tinkerMd, /New body/);
  await assert.rejects(
    fs.stat(path.join(worktree, ".claude", "skills", "tinker", "references", "api.md")),
    "files removed from the catalog are removed from the install"
  );
  const codexMd = await fs.readFile(path.join(worktree, ".agents", "skills", "tinker", "SKILL.md"), "utf8");
  assert.match(codexMd, /New body/);
  const row = await db.documentSkill.findUnique({
    where: { documentId_name: { documentId: document.id, name: "tinker" } }
  });
  assert.equal(row?.description, "Tinker, second edition.");
  assert.equal(row?.catalogName, "tinker");

  const ownMd = await fs.readFile(path.join(worktree, ".claude", "skills", "openweights", "SKILL.md"), "utf8");
  assert.match(ownMd, /My own version/, "uploaded skills are never overwritten by the catalog");

  // An unreachable catalog keeps the stored copy instead of failing the run.
  process.env.SKILL_CATALOG_GIT_URL = path.join(os.tmpdir(), `missing-catalog-${crypto.randomUUID()}`);
  const worktree2 = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-refresh-worktree-"));
  t.after(() => fs.rm(worktree2, { recursive: true, force: true }));
  await syncDocumentSkillsForRun(document.id, worktree2);
  assert.match(await fs.readFile(path.join(worktree2, ".claude", "skills", "tinker", "SKILL.md"), "utf8"), /New body/);
});
