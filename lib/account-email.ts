// Email verification and password reset: signed link tokens plus the emails
// that carry them.
//
// Both tokens are stateless HS256 JWTs under SESSION_SECRET with a `purpose`
// claim, like lib/slack/link-token.ts, and both are bound to a fingerprint of
// the password hash they were issued for. Once the password changes, every
// outstanding link stops verifying: that makes a reset link single-use, and
// means re-signing-up over an unconfirmed account voids the earlier
// confirmation links (which would otherwise confirm the older password).
//
// Deliberately does NOT import lib/auth.ts (next/headers) so headless tests
// can exercise the round trips.

import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

import { sendEmail } from "@/lib/email";

const VERIFY_PURPOSE = "email-verification";
const RESET_PURPOSE = "password-reset";
const encoder = new TextEncoder();

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required.");
  }
  return encoder.encode(secret);
}

// Same-origin relative paths only, so a link can't bounce the user elsewhere.
export function safeReturnTo(value: unknown) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/dashboard";
}

function passwordFingerprint(passwordHash: string) {
  return createHash("sha256").update(passwordHash).digest("hex").slice(0, 16);
}

export async function createVerificationToken(user: { id: string; email: string; passwordHash: string }, returnTo?: string) {
  return new SignJWT({
    purpose: VERIFY_PURPOSE,
    email: user.email,
    pwf: passwordFingerprint(user.passwordHash),
    next: safeReturnTo(returnTo)
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("3d")
    .sign(getSecret());
}

// The caller must check the email claim against the account (a link for an
// address the user has since left must not verify the new one) and the
// fingerprint with tokenMatchesPassword.
export async function verifyVerificationToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (
      payload.purpose !== VERIFY_PURPOSE ||
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.pwf !== "string"
    ) {
      return null;
    }
    return { userId: payload.sub, email: payload.email, fingerprint: payload.pwf, returnTo: safeReturnTo(payload.next) };
  } catch {
    return null;
  }
}

export async function createPasswordResetToken(user: { id: string; passwordHash: string }) {
  return new SignJWT({ purpose: RESET_PURPOSE, pwf: passwordFingerprint(user.passwordHash) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(getSecret());
}

// Returns the user id plus the fingerprint; the caller must compare it against
// the user's CURRENT hash with tokenMatchesPassword.
export async function verifyPasswordResetToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.purpose !== RESET_PURPOSE || typeof payload.sub !== "string" || typeof payload.pwf !== "string") {
      return null;
    }
    return { userId: payload.sub, fingerprint: payload.pwf };
  } catch {
    return null;
  }
}

export function tokenMatchesPassword(fingerprint: string, passwordHash: string) {
  return fingerprint === passwordFingerprint(passwordHash);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function renderEmail(intro: string, buttonLabel: string, url: string, outro: string) {
  const text = `${intro}\n\n${url}\n\n${outro}\n`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1f2328;max-width:520px">
<p>${escapeHtml(intro)}</p>
<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="background:#1f2328;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(buttonLabel)}</a></p>
<p style="color:#59636e;font-size:13px">Or paste this link into your browser:<br><a href="${escapeHtml(url)}" style="color:#59636e;word-break:break-all">${escapeHtml(url)}</a></p>
<p style="color:#59636e;font-size:13px">${escapeHtml(outro)}</p>
</div>`;
  return { text, html };
}

export async function sendVerificationEmail(user: { id: string; email: string; name: string; passwordHash: string }, origin: string, returnTo?: string) {
  const token = await createVerificationToken(user, returnTo);
  const url = `${origin}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  return sendEmail({
    to: user.email,
    subject: "Confirm your r-docs email address",
    ...renderEmail(
      `Hi ${user.name}, please confirm that this is your email address to finish creating your r-docs account.`,
      "Confirm email",
      url,
      "The link is valid for 3 days. If you didn't sign up for r-docs, you can ignore this email."
    )
  });
}

export async function sendPasswordResetEmail(user: { id: string; email: string; name: string; passwordHash: string }, origin: string) {
  const token = await createPasswordResetToken(user);
  const url = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
  return sendEmail({
    to: user.email,
    subject: "Reset your r-docs password",
    ...renderEmail(
      `Hi ${user.name}, someone (hopefully you) asked to reset the password for your r-docs account.`,
      "Choose a new password",
      url,
      "The link is valid for 1 hour and works once. If you didn't ask for this, you can ignore this email — your password stays the same."
    )
  });
}
