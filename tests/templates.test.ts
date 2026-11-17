import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import {
  createDocumentFromTemplate,
  getTemplateStateForViewer,
  listAddedTemplates,
  listTemplateOffers,
  listTemplatesForUser,
  setUserTemplateStatus,
  TemplateError
} from "../lib/templates";

// Templates are per user: anyone who can open a document may use it as a
// template (UserTemplate "added"); when the OWNER does, the people it is shared
// with are offered it once.

async function makeUser(tag: string) {
  return db.user.create({
    data: { email: `tpl-${tag}-${crypto.randomUUID()}@example.com`, name: tag, passwordHash: "x" }
  });
}

const paragraph = (text: string, marks?: unknown[]) => ({
  type: "paragraph",
  content: [{ type: "text", text, ...(marks ? { marks } : {}) }]
});

test("using a shared document as a template, offers, dismissing and losing access", async () => {
  const ann = await makeUser("ann");
  const bo = await makeUser("bo");
  const cy = await makeUser("cy");
  const doc = await db.document.create({
    data: { title: "Weekly report", content: JSON.stringify({ type: "doc", content: [paragraph("x")] }), ownerId: ann.id }
  });
  try {
    await db.documentMembership.create({ data: { documentId: doc.id, userId: bo.id, permission: "VIEW" } });

    // Nobody uses it as a template yet: nothing listed, nothing offered.
    assert.deepEqual(await listTemplatesForUser(ann.id), []);
    assert.deepEqual(await listTemplatesForUser(bo.id), []);
    assert.deepEqual(await getTemplateStateForViewer(doc.id, bo.id), { isTemplate: false, status: null, offer: false });

    // Bo, who only has view access to Ann's document, uses it as a template.
    await setUserTemplateStatus(bo.id, doc.id, "added");
    assert.deepEqual((await listAddedTemplates(bo.id)).map((t) => [t.id, t.ownerName, t.isOwner]), [[doc.id, "ann", false]]);
    assert.equal((await getTemplateStateForViewer(doc.id, bo.id)).isTemplate, true);
    // That is Bo's own business: it is not a template for the owner, and nobody is asked.
    assert.deepEqual(await listTemplatesForUser(ann.id), []);
    assert.deepEqual(await getTemplateStateForViewer(doc.id, ann.id), { isTemplate: false, status: null, offer: false });
    await db.documentMembership.create({ data: { documentId: doc.id, userId: cy.id, permission: "VIEW" } });
    assert.deepEqual(await listTemplatesForUser(cy.id), []);
    assert.equal((await getTemplateStateForViewer(doc.id, cy.id)).offer, false);
    await db.documentMembership.deleteMany({ where: { documentId: doc.id, userId: cy.id } });
    await setUserTemplateStatus(bo.id, doc.id, "dismissed");
    await db.userTemplate.deleteMany({ where: { documentId: doc.id } });

    // The owner uses it: in their list right away, never "offered" to themselves.
    await setUserTemplateStatus(ann.id, doc.id, "added");
    assert.deepEqual((await listAddedTemplates(ann.id)).map((t) => t.id), [doc.id]);
    assert.deepEqual(await listTemplateOffers(ann.id), []);
    assert.equal((await getTemplateStateForViewer(doc.id, ann.id)).offer, false);

    // The collaborator is asked; it is not in their list until they say yes.
    assert.deepEqual((await listTemplateOffers(bo.id)).map((t) => [t.id, t.ownerName]), [[doc.id, "ann"]]);
    assert.deepEqual(await listAddedTemplates(bo.id), []);
    assert.equal((await getTemplateStateForViewer(doc.id, bo.id)).offer, true);

    // Someone without access sees nothing and can neither add nor use it.
    assert.deepEqual(await listTemplatesForUser(cy.id), []);
    await assert.rejects(setUserTemplateStatus(cy.id, doc.id, "added"), (e) => e instanceof TemplateError && e.status === 404);
    await assert.rejects(createDocumentFromTemplate(cy.id, doc.id), (e) => e instanceof TemplateError && e.status === 404);

    await setUserTemplateStatus(bo.id, doc.id, "added");
    assert.deepEqual((await listAddedTemplates(bo.id)).map((t) => t.id), [doc.id]);
    assert.deepEqual(await listTemplateOffers(bo.id), []);

    // Removing it (settings) is remembered: no second offer.
    await setUserTemplateStatus(bo.id, doc.id, "dismissed");
    assert.deepEqual(await listAddedTemplates(bo.id), []);
    assert.deepEqual(await listTemplateOffers(bo.id), []);
    assert.equal((await getTemplateStateForViewer(doc.id, bo.id)).offer, false);
    assert.deepEqual((await listTemplatesForUser(bo.id)).map((t) => t.status), ["dismissed"]);

    // Sharing through a group offers it too.
    const group = await db.group.create({ data: { name: `tpl-${crypto.randomUUID()}`, ownerId: ann.id } });
    await db.groupMember.create({ data: { groupId: group.id, userId: cy.id } });
    await db.documentGroupAccess.create({ data: { documentId: doc.id, groupId: group.id, permission: "VIEW" } });
    assert.deepEqual((await listTemplateOffers(cy.id)).map((t) => t.id), [doc.id]);

    // Losing access takes an added template out of the list.
    await setUserTemplateStatus(bo.id, doc.id, "added");
    await db.documentMembership.deleteMany({ where: { documentId: doc.id, userId: bo.id } });
    assert.deepEqual(await listAddedTemplates(bo.id), []);
    await assert.rejects(createDocumentFromTemplate(bo.id, doc.id), TemplateError);

    // The owner stops using it: gone from their list, no more offers; whoever
    // added it for themselves keeps it.
    await setUserTemplateStatus(cy.id, doc.id, "added");
    await setUserTemplateStatus(ann.id, doc.id, "dismissed");
    assert.deepEqual(await listAddedTemplates(ann.id), []);
    assert.deepEqual((await listAddedTemplates(cy.id)).map((t) => t.id), [doc.id]);
    await db.documentMembership.create({ data: { documentId: doc.id, userId: bo.id, permission: "VIEW" } });
    await db.userTemplate.deleteMany({ where: { documentId: doc.id, userId: bo.id } });
    assert.deepEqual(await listTemplateOffers(bo.id), []);
    await db.group.delete({ where: { id: group.id } });
  } finally {
    await db.document.deleteMany({ where: { ownerId: { in: [ann.id, bo.id, cy.id] } } });
    await db.user.deleteMany({ where: { id: { in: [ann.id, bo.id, cy.id] } } });
  }
});

test("a document started from a template is an independent copy owned by the user", async () => {
  const ann = await makeUser("ann");
  const bo = await makeUser("bo");
  const content = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Report" }] },
      paragraph("Summary goes here", [{ type: "commentAnchor", attrs: { threadId: "t1" } }]),
      { type: "embeddedWidget", attrs: { widgetId: "w1", documentId: "other", label: "Chart" } },
      { type: "repoImage", attrs: { src: "/api/documents/other/repo-files?path=a.png", path: "a.png" } },
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph("first point")] }] }
    ]
  };
  const template = await db.document.create({
    data: {
      title: "Report template",
      content: JSON.stringify(content),
      ownerId: ann.id,
      agentModel: "claude-opus-latest",
      agentEffort: "high",
      repoUrl: "https://github.com/example/private"
    }
  });
  try {
    await db.documentMembership.create({ data: { documentId: template.id, userId: bo.id, permission: "VIEW" } });

    // VIEW access is enough to start from a document, and it need not be in the list.
    const created = await createDocumentFromTemplate(bo.id, template.id);
    const copy = await db.document.findUniqueOrThrow({
      where: { id: created.id },
      include: { memberships: true }
    });
    assert.equal(copy.ownerId, bo.id);
    assert.equal(copy.title, "Report template");
    assert.equal((await getTemplateStateForViewer(copy.id, bo.id)).isTemplate, false);
    assert.equal(copy.agentModel, "claude-opus-latest");
    assert.equal(copy.agentEffort, "high");
    assert.equal(copy.repoUrl, null);
    assert.deepEqual(copy.memberships, []);

    const copied = JSON.parse(copy.content) as { content: Array<{ type: string }> };
    // Text and structure survive; widgets / repo images / comment anchors of
    // the template do not.
    assert.deepEqual(copied.content.map((node) => node.type), ["heading", "paragraph", "bulletList"]);
    assert.ok(!copy.content.includes("commentAnchor"));
    assert.ok(copy.content.includes("Summary goes here"));
    assert.ok(copy.content.includes("first point"));

    // The template itself is untouched.
    assert.equal((await db.document.findUniqueOrThrow({ where: { id: template.id } })).content, JSON.stringify(content));
  } finally {
    await db.document.deleteMany({ where: { ownerId: { in: [ann.id, bo.id] } } });
    await db.user.deleteMany({ where: { id: { in: [ann.id, bo.id] } } });
  }
});
