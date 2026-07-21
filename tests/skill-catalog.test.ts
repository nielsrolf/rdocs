import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listCatalogSkills, loadCatalogSkill } from "../lib/skill-catalog";

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
