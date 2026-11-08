import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { loadMentionCandidates } from "../lib/mention-data";
import { filterMentionCandidates, personMatchRank } from "../lib/mentions";
import { searchUsers } from "../lib/user-search";

test("personMatchRank matches any name word and email local-part words", () => {
  const ada = { name: "Ada Lovelace", email: "countess.ada@example.com" };
  assert.equal(personMatchRank("ada", ada), 0);
  assert.equal(personMatchRank("lov", ada), 1);
  assert.equal(personMatchRank("count", ada), 2);
  assert.equal(personMatchRank("ada@", { name: "", email: "ada@example.com" }), 2);
  assert.equal(personMatchRank("example", ada), null, "the email domain alone does not match");
  assert.equal(personMatchRank("velace", ada), null, "mid-word substrings do not match");
});

test("mention autocomplete finds people by last name", () => {
  const ids = filterMentionCandidates("love", [
    { id: "a", name: "Ada Lovelace" },
    { id: "b", name: "Lovell" },
    { id: "c", name: "Grace Hopper" }
  ]).map((candidate) => candidate.id);
  assert.deepEqual(ids, ["b", "a"], "full-name prefix ranks above a later-word prefix");
});

async function user(name: string) {
  const tag = crypto.randomUUID().slice(0, 8);
  return db.user.create({
    data: { email: `${name.split(" ")[0].toLowerCase()}-${tag}@example.com`, name: `${name} ${tag}`, passwordHash: "x" }
  });
}

test("searchUsers matches by name word, ranks known people first, honours excludes", async (t) => {
  const me = await user("Searcher");
  const stranger = await user("Zed Quuxperson");
  const teammate = await user("Zed Quuxmate");
  const groupie = await user("Quuxgroupie");
  const group = await db.group.create({
    data: { name: "team", ownerId: me.id, members: { create: [{ userId: me.id, role: "owner" }, { userId: groupie.id }] } }
  });
  const document = await db.document.create({
    data: { title: "d", content: "{}", ownerId: me.id, memberships: { create: { userId: teammate.id, permission: "EDIT" } } }
  });
  t.after(async () => {
    await db.document.deleteMany({ where: { id: document.id } });
    await db.group.deleteMany({ where: { id: group.id } });
    await db.user.deleteMany({ where: { id: { in: [me.id, stranger.id, teammate.id, groupie.id] } } });
  });

  const found = await searchUsers({ viewerId: me.id, query: "quux" });
  const ids = found.map((row) => row.id);
  assert.ok(ids.includes(stranger.id) && ids.includes(teammate.id) && ids.includes(groupie.id));
  // groupie is a full-name prefix (rank 0); among the two "Zed Quux…" (rank 1)
  // the collaborator comes before the stranger.
  assert.equal(ids[0], groupie.id);
  assert.ok(ids.indexOf(teammate.id) < ids.indexOf(stranger.id));
  assert.equal(found.find((row) => row.id === teammate.id)?.known, true);
  assert.equal(found.find((row) => row.id === stranger.id)?.known, false);

  const excluded = await searchUsers({ viewerId: me.id, query: "quux", excludeIds: [groupie.id] });
  assert.ok(!excluded.some((row) => row.id === groupie.id));

  const empty = await searchUsers({ viewerId: me.id, query: "" });
  assert.deepEqual(new Set(empty.map((row) => row.id)), new Set([teammate.id, groupie.id]));
});

test("people with access through a shared group can be @mentioned in the document", async (t) => {
  const owner = await user("Docowner");
  const groupOwner = await user("Teamlead");
  const member = await user("Teammember");
  const group = await db.group.create({
    data: { name: "team", ownerId: groupOwner.id, members: { create: { userId: member.id } } }
  });
  const document = await db.document.create({
    data: { title: "d", content: "{}", ownerId: owner.id, groupAccess: { create: { groupId: group.id, permission: "COMMENT" } } }
  });
  t.after(async () => {
    await db.document.deleteMany({ where: { id: document.id } });
    await db.group.deleteMany({ where: { id: group.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, groupOwner.id, member.id] } } });
  });

  const ids = new Set((await loadMentionCandidates(document.id)).map((candidate) => candidate.id));
  assert.deepEqual(ids, new Set([owner.id, groupOwner.id, member.id]));
});
