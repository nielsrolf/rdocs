import assert from "node:assert/strict";
import test from "node:test";

import { agentAccessModeForDocumentAccess, canManageDocumentAutomation } from "../lib/permissions";

test("share-link agent access follows the link permission", () => {
  assert.equal(agentAccessModeForDocumentAccess({ permission: "VIEW", viaShareLink: true }), "read_only");
  assert.equal(agentAccessModeForDocumentAccess({ permission: "COMMENT", viaShareLink: true }), "read_only");
  assert.equal(agentAccessModeForDocumentAccess({ permission: "EDIT", viaShareLink: true }), "workspace");
});

test("account memberships retain normal workspace agents", () => {
  assert.equal(agentAccessModeForDocumentAccess({ permission: "COMMENT", viaShareLink: false }), "workspace");
  assert.equal(agentAccessModeForDocumentAccess({ permission: "EDIT", viaShareLink: false }), "workspace");
});

test("bearer links can edit content but cannot manage secrets, skills, or executable widgets", () => {
  assert.equal(canManageDocumentAutomation({ permission: "EDIT", viaShareLink: true }, null), false);
  assert.equal(canManageDocumentAutomation({ permission: "EDIT", viaShareLink: true }, "signed-in"), false);
  assert.equal(canManageDocumentAutomation({ permission: "EDIT", viaShareLink: false }, "member"), true);
  assert.equal(canManageDocumentAutomation({ permission: "COMMENT", viaShareLink: false }, "member"), false);
});
