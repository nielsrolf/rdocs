import assert from "node:assert/strict";
import test from "node:test";

import {
  createPasswordResetToken,
  createVerificationToken,
  safeReturnTo,
  tokenMatchesPassword,
  verifyPasswordResetToken,
  verifyVerificationToken
} from "../lib/account-email";
import { emailEnabled, isDeliverableAddress, sendEmail } from "../lib/email";

process.env.SESSION_SECRET = "test-session-secret";

const user = { id: "u1", email: "ada@example.com", name: "Ada", passwordHash: "$2a$12$first" };

test("verification token round-trips user, email and return path", async () => {
  const token = await createVerificationToken(user, "/documents/abc");
  const claims = await verifyVerificationToken(token);
  assert.equal(claims?.userId, "u1");
  assert.equal(claims?.email, "ada@example.com");
  assert.equal(claims?.returnTo, "/documents/abc");
  assert.ok(tokenMatchesPassword(claims!.fingerprint, user.passwordHash));
});

test("re-signing up with a new password voids earlier verification links", async () => {
  const claims = await verifyVerificationToken(await createVerificationToken(user));
  assert.equal(tokenMatchesPassword(claims!.fingerprint, "$2a$12$second"), false);
});

test("return path cannot point off-site", async () => {
  assert.equal(safeReturnTo("//evil.example.com/x"), "/dashboard");
  assert.equal(safeReturnTo("https://evil.example.com"), "/dashboard");
  assert.equal(safeReturnTo(undefined), "/dashboard");
  const claims = await verifyVerificationToken(await createVerificationToken(user, "//evil.example.com"));
  assert.equal(claims?.returnTo, "/dashboard");
});

test("reset token is bound to the password it was issued for", async () => {
  const claims = await verifyPasswordResetToken(await createPasswordResetToken(user));
  assert.equal(claims?.userId, "u1");
  assert.ok(tokenMatchesPassword(claims!.fingerprint, user.passwordHash));
  // After the reset the hash changes, so the same link no longer works.
  assert.equal(tokenMatchesPassword(claims!.fingerprint, "$2a$12$changed"), false);
});

test("the two token kinds are not interchangeable", async () => {
  assert.equal(await verifyPasswordResetToken(await createVerificationToken(user)), null);
  assert.equal(await verifyVerificationToken(await createPasswordResetToken(user)), null);
});

test("tampered or foreign-secret tokens are rejected", async () => {
  const token = await createPasswordResetToken(user);
  assert.equal(await verifyPasswordResetToken(token + "x"), null);
  process.env.SESSION_SECRET = "another-secret";
  try {
    assert.equal(await verifyPasswordResetToken(token), null);
  } finally {
    process.env.SESSION_SECRET = "test-session-secret";
  }
});

test("reserved test domains are never sent to", () => {
  assert.equal(isDeliverableAddress("int-123@example.com"), false);
  assert.equal(isDeliverableAddress("a@foo.test"), false);
  assert.equal(isDeliverableAddress("a@example.org"), false);
  assert.equal(isDeliverableAddress("niels@gmail.com"), true);
  assert.equal(isDeliverableAddress("someone@myexample.com"), true);
});

test("without RESEND_API_KEY nothing is sent and callers see email as disabled", async () => {
  const saved = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    assert.equal(emailEnabled(), false);
    assert.deepEqual(await sendEmail({ to: "niels@gmail.com", subject: "x", text: "y" }), { sent: false });
  } finally {
    if (saved !== undefined) process.env.RESEND_API_KEY = saved;
  }
});
