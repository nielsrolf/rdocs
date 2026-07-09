import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";

import { db } from "../../lib/db";
import { getDocumentSkillDir } from "../../lib/skills";
import { seedUser } from "./helpers";

// HTTP coverage of agent skills: the per-user library (upload / default toggle
// / delete), default-skill copying at document creation, and per-document
// attach (direct upload, copy-from-library) with the edit-permission guard.
// Targets a RUNNING server (GDOCS_TEST_URL, default http://localhost:14141);
// skips if unreachable. Assumes the server shares this checkout's cwd (true
// for the local deploy), which lets us assert on-disk materialization.

const BASE = process.env.GDOCS_TEST_URL ?? "http://localhost:14141";

let reachablePromise: Promise<boolean> | null = null;
function serverReachable(): Promise<boolean> {
  if (!reachablePromise) {
    reachablePromise = fetch(`${BASE}/api/documents`, { method: "GET" })
      .then(() => true)
      .catch(() => {
        console.warn(`[integration] server not reachable at ${BASE} — skipping skills suite.`);
        return false;
      });
  }
  return reachablePromise;
}

function itLive(name: string, fn: (t: import("node:test").TestContext) => Promise<void>) {
  test(name, async (t) => {
    if (!(await serverReachable())) {
      t.skip(`server not reachable at ${BASE}`);
      return;
    }
    await fn(t);
  });
}

const createdEmails: string[] = [];
const createdUserIds: string[] = [];
const createdDocumentIds: string[] = [];

after(async () => {
  for (const documentId of createdDocumentIds) {
    await db.document.deleteMany({ where: { id: documentId } }).catch(() => undefined);
    await fs
      .rm(path.join(process.cwd(), ".research-workspaces", documentId), { recursive: true, force: true })
      .catch(() => undefined);
  }
  for (const email of createdEmails) {
    await db.user.deleteMany({ where: { email } }).catch(() => undefined);
  }
  for (const userId of createdUserIds) {
    await fs
      .rm(path.join(process.cwd(), ".user-skills", userId), { recursive: true, force: true })
      .catch(() => undefined);
  }
  await db.$disconnect().catch(() => undefined);
});

async function signUp(): Promise<{ cookie: string; userId: string }> {
  const seeded = await seedUser();
  createdEmails.push(seeded.email);
  createdUserIds.push(seeded.userId);
  return { cookie: seeded.cookie, userId: seeded.userId };
}

function authed(cookie: string, url: string, init: RequestInit = {}) {
  return fetch(`${BASE}${url}`, {
    ...init,
    headers: { Cookie: cookie, ...(init.headers ?? {}) }
  });
}

function skillForm(name: string, description: string, extraFiles: Array<[string, string]> = []) {
  const formData = new FormData();
  const skillMd = `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`;
  formData.append("files", new Blob([skillMd], { type: "text/markdown" }), "SKILL.md");
  formData.append("paths", `${name}/SKILL.md`);
  for (const [relativePath, content] of extraFiles) {
    formData.append("files", new Blob([content]), path.basename(relativePath));
    formData.append("paths", `${name}/${relativePath}`);
  }
  return formData;
}

itLive("user skill library: upload, default toggle, copy into new documents, delete", async () => {
  const owner = await signUp();

  // Upload a two-file skill into the library.
  let res = await authed(owner.cookie, "/api/user/skills", {
    method: "POST",
    body: skillForm("release-notes", "How to write release notes.", [["references/tone.md", "friendly"]])
  });
  assert.equal(res.status, 200);
  const uploaded = (await res.json()).skill;
  assert.equal(uploaded.name, "release-notes");
  assert.equal(uploaded.description, "How to write release notes.");
  assert.equal(uploaded.isDefault, false);

  // Mark it default.
  res = await authed(owner.cookie, `/api/user/skills/${uploaded.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isDefault: true })
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).skill.isDefault, true);

  // A newly created document inherits the default skill (row + files).
  res = await authed(owner.cookie, "/api/documents", { method: "POST" });
  assert.equal(res.status, 200);
  const documentId = (await res.json()).id as string;
  createdDocumentIds.push(documentId);

  res = await authed(owner.cookie, `/api/documents/${documentId}/skills`);
  assert.equal(res.status, 200);
  const docSkills = (await res.json()).skills;
  assert.deepEqual(
    docSkills.map((skill: { name: string }) => skill.name),
    ["release-notes"]
  );
  const materialized = await fs.readFile(
    path.join(getDocumentSkillDir(documentId, "release-notes"), "references", "tone.md"),
    "utf8"
  );
  assert.equal(materialized, "friendly");

  // Library delete removes the row; the document's copy stays.
  res = await authed(owner.cookie, `/api/user/skills/${uploaded.id}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  res = await authed(owner.cookie, "/api/user/skills");
  assert.deepEqual((await res.json()).skills, []);
  res = await authed(owner.cookie, `/api/documents/${documentId}/skills`);
  assert.equal(((await res.json()).skills as unknown[]).length, 1);
});

itLive("document skills: direct upload, copy from library, permission guard, delete", async () => {
  const owner = await signUp();
  const stranger = await signUp();

  const res = await authed(owner.cookie, "/api/documents", { method: "POST" });
  const documentId = (await res.json()).id as string;
  createdDocumentIds.push(documentId);

  // Direct upload by the owner.
  let response = await authed(owner.cookie, `/api/documents/${documentId}/skills`, {
    method: "POST",
    body: skillForm("data-viz", "Chart conventions.")
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).skill.name, "data-viz");

  // A user without access can neither upload nor list.
  response = await authed(stranger.cookie, `/api/documents/${documentId}/skills`, {
    method: "POST",
    body: skillForm("evil", "Nope.")
  });
  assert.equal(response.status, 403);
  response = await authed(stranger.cookie, `/api/documents/${documentId}/skills`);
  assert.equal(response.status, 404);

  // Copy a library skill into the document via the JSON mode.
  response = await authed(owner.cookie, "/api/user/skills", {
    method: "POST",
    body: skillForm("checklists", "Checklist style.")
  });
  const librarySkill = (await response.json()).skill;
  response = await authed(owner.cookie, `/api/documents/${documentId}/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userSkillId: librarySkill.id })
  });
  assert.equal(response.status, 200);

  response = await authed(owner.cookie, `/api/documents/${documentId}/skills`);
  const skills = (await response.json()).skills as Array<{ id: string; name: string }>;
  assert.deepEqual(skills.map((skill) => skill.name).sort(), ["checklists", "data-viz"]);

  // Copying someone else's library skill is rejected.
  response = await authed(stranger.cookie, "/api/user/skills", {
    method: "POST",
    body: skillForm("strangers-skill", "Not yours.")
  });
  const strangerSkill = (await response.json()).skill;
  response = await authed(owner.cookie, `/api/documents/${documentId}/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userSkillId: strangerSkill.id })
  });
  assert.equal(response.status, 404);

  // Detach one.
  const dataViz = skills.find((skill) => skill.name === "data-viz");
  response = await authed(owner.cookie, `/api/documents/${documentId}/skills/${dataViz!.id}`, {
    method: "DELETE"
  });
  assert.equal(response.status, 200);
  const gone = await fs
    .stat(getDocumentSkillDir(documentId, "data-viz"))
    .then(() => true)
    .catch(() => false);
  assert.equal(gone, false);
});
