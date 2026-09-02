import assert from "node:assert/strict";
import test from "node:test";

import { buildRedirect, issueIdToken, parseRedirectUri, verifyIdToken } from "../lib/integration-signin";

process.env.INTEGRATION_SIGNIN_SECRET = "test-secret";
process.env.AGENT_SETUP_ALLOWED_ORIGINS = "https://forecasting.example.com, http://100.64.0.1:14160";

test("redirect_uri must be an allow-listed origin without query or fragment", () => {
  assert.equal(parseRedirectUri("https://forecasting.example.com/auth/callback")?.host, "forecasting.example.com");
  assert.equal(parseRedirectUri("http://100.64.0.1:14160/auth/callback")?.port, "14160");
  assert.equal(parseRedirectUri("https://evil.example.com/auth/callback"), null);
  assert.equal(parseRedirectUri("https://forecasting.example.com/cb?x=1"), null);
  assert.equal(parseRedirectUri("https://forecasting.example.com/cb#frag"), null);
  assert.equal(parseRedirectUri("javascript:alert(1)"), null);
  assert.equal(parseRedirectUri(undefined), null);
});

test("id token carries the user and is bound to the redirect origin", async () => {
  const user = { id: "u1", email: "a@example.com", name: "Ada" };
  const token = await issueIdToken(user, "https://forecasting.example.com");
  assert.deepEqual(await verifyIdToken(token, "https://forecasting.example.com"), user);
  await assert.rejects(verifyIdToken(token, "https://other.example.com"));
  await assert.rejects(verifyIdToken(token + "x", "https://forecasting.example.com"));
});

test("redirect appends id_token and state to the callback", () => {
  const url = buildRedirect(new URL("https://forecasting.example.com/auth/callback"), "tok", "s1");
  assert.equal(url.searchParams.get("id_token"), "tok");
  assert.equal(url.searchParams.get("state"), "s1");
  assert.equal(url.pathname, "/auth/callback");
});
