import { sendVerificationEmail } from "@/lib/account-email";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { emailEnabled } from "@/lib/email";

// Account creation and password checks for trusted "Sign in with r-docs"
// integrations (see lib/integration-groups.ts for the bearer token). They let
// an integration offer sign-up / sign-in on its own pages while the account
// stays an ordinary r-docs account: same rules as /api/auth/sign-up and
// /api/auth/sign-in, including email verification. The integration is
// responsible for rate limiting by end-user IP; the routes add per-email and
// per-forwarded-IP limits as a backstop.

export type IntegrationAccount = { id: string; email: string; name: string; emailVerificationPending: boolean };

export type CreateAccountResult =
  | { ok: true; user: IntegrationAccount; verificationEmailSent: boolean }
  | { ok: false; status: number; error: string };

function canonicalOrigin() {
  return process.env.APP_URL?.trim() || "https://docs.nielsrolf.com";
}

export async function createIntegrationAccount(input: { name: string; email: string; password: string }): Promise<CreateAccountResult> {
  const email = input.email.trim().toLowerCase();
  const existing = await db.user.findUnique({ where: { email }, select: { id: true, emailVerificationPending: true } });
  // Same rule as /api/auth/sign-up: an unconfirmed account can be claimed again.
  if (existing && !existing.emailVerificationPending) {
    return { ok: false, status: 409, error: "That email already has an account. Sign in with its password instead." };
  }
  const requireVerification = emailEnabled();
  const data = {
    name: input.name.trim(),
    passwordHash: await hashPassword(input.password),
    emailVerificationPending: requireVerification
  };
  const fields = { id: true, email: true, name: true, passwordHash: true, emailVerificationPending: true } as const;
  const user = existing
    ? await db.user.update({ where: { id: existing.id }, data, select: fields })
    : await db.user.create({ data: { email, ...data }, select: fields });
  let verificationEmailSent = false;
  if (requireVerification) {
    try {
      await sendVerificationEmail(user, canonicalOrigin());
      verificationEmailSent = true;
    } catch (error) {
      // The integration signs the user in anyway; they can resend from r-docs.
      console.error("[integration-accounts] verification email failed", error);
    }
  }
  console.log("[integration-accounts] account created", { userId: user.id, reclaimed: Boolean(existing) });
  return {
    ok: true,
    verificationEmailSent,
    user: { id: user.id, email: user.email, name: user.name, emailVerificationPending: user.emailVerificationPending }
  };
}

export type CheckPasswordResult =
  | { ok: true; user: IntegrationAccount }
  | { ok: false; status: number; error: string; needsVerification?: boolean };

export async function checkIntegrationPassword(emailInput: string, password: string): Promise<CheckPasswordResult> {
  const user = await db.user.findUnique({
    where: { email: emailInput.trim().toLowerCase() },
    select: { id: true, email: true, name: true, passwordHash: true, emailVerificationPending: true }
  });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return { ok: false, status: 401, error: "Incorrect email or password." };
  }
  // Only reached with the right password, as in /api/auth/sign-in.
  if (user.emailVerificationPending) {
    return {
      ok: false,
      status: 403,
      needsVerification: true,
      error: "Please confirm your email address first — check your inbox for the link from r-docs."
    };
  }
  return { ok: true, user: { id: user.id, email: user.email, name: user.name, emailVerificationPending: false } };
}
