import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveCommentScope,
  legacyBooleanForScope,
  normalizeCommentNotificationScope,
  scopeWantsNotification,
  userDefaultCommentScope
} from "../lib/notification-preferences";

// Pure resolution rules for comment-notification scopes. No DB, no Slack.

test("normalize falls back for unknown values", () => {
  assert.equal(normalizeCommentNotificationScope("all"), "all");
  assert.equal(normalizeCommentNotificationScope("nonsense"), "participating");
  assert.equal(normalizeCommentNotificationScope(null, "none"), "none");
});

test("user default: the scope column wins, the legacy boolean is the fallback", () => {
  assert.equal(userDefaultCommentScope({ commentNotificationScope: "all" }), "all");
  assert.equal(
    userDefaultCommentScope({ commentNotificationScope: "none", commentSlackNotifications: true }),
    "none"
  );
  // Rows written before the scope column existed.
  assert.equal(userDefaultCommentScope({ commentSlackNotifications: false }), "none");
  assert.equal(userDefaultCommentScope({ commentSlackNotifications: true }), "participating");
  assert.equal(userDefaultCommentScope({}), "participating");
});

test("effective scope: a per-document preference overrides the user default", () => {
  const user = { commentNotificationScope: "participating" };
  assert.equal(effectiveCommentScope({ user, preference: null }), "participating");
  assert.equal(effectiveCommentScope({ user, preference: { commentScope: "all" } }), "all");
  assert.equal(effectiveCommentScope({ user, preference: { commentScope: "none" } }), "none");
  // Legacy per-document rows: the boolean maps onto the two extremes.
  assert.equal(
    effectiveCommentScope({ user, preference: { commentSlackNotifications: true } }),
    "all"
  );
  assert.equal(
    effectiveCommentScope({ user, preference: { commentSlackNotifications: false } }),
    "none"
  );
});

test("scopeWantsNotification", () => {
  const involved = { participant: true, mentioned: false };
  const uninvolved = { participant: false, mentioned: false };
  const tagged = { participant: false, mentioned: true };

  assert.equal(scopeWantsNotification("none", involved), false);
  assert.equal(scopeWantsNotification("all", uninvolved), true);
  assert.equal(scopeWantsNotification("participating", involved), true);
  assert.equal(scopeWantsNotification("participating", uninvolved), false);
  assert.equal(scopeWantsNotification("participating", tagged), true);
});

test("legacy mirror keeps old code readable during a blue/green overlap", () => {
  assert.equal(legacyBooleanForScope("all"), true);
  assert.equal(legacyBooleanForScope("participating"), true);
  assert.equal(legacyBooleanForScope("none"), false);
});
