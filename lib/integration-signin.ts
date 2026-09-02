import { SignJWT, jwtVerify } from "jose";

import { isAllowedAgentSetupUrl } from "@/lib/agent-setup-origins";

// "Sign in with r-docs" for other services. A signed-in user visits
// /authorize?redirect_uri=…&state=…, confirms, and is redirected back with a
// short-lived HS256 id token (sub/email/name, aud = the redirect origin). The
// integration verifies it with the shared INTEGRATION_SIGNIN_SECRET and opens
// its own session. Redirect origins reuse AGENT_SETUP_ALLOWED_ORIGINS, so an
// integration is either fully trusted or not at all. No state is stored here.

const encoder = new TextEncoder();
export const ID_TOKEN_TTL_SECONDS = 120;

export function integrationSigninEnabled() {
  return Boolean(process.env.INTEGRATION_SIGNIN_SECRET);
}

function secret() {
  const value = process.env.INTEGRATION_SIGNIN_SECRET;
  if (!value) throw new Error("INTEGRATION_SIGNIN_SECRET is required for integration sign-in.");
  return encoder.encode(value);
}

// The redirect target must be an allow-listed origin and must not carry a
// query (we append ours) or a fragment.
export function parseRedirectUri(value: string | undefined | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.hash || url.search) return null;
    return isAllowedAgentSetupUrl(url.toString()) ? url : null;
  } catch {
    return null;
  }
}

export async function issueIdToken(user: { id: string; email: string; name: string }, audience: string) {
  return new SignJWT({ email: user.email, name: user.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setAudience(audience)
    .setIssuer(process.env.APP_URL?.trim() || "r-docs")
    .setIssuedAt()
    .setExpirationTime(`${ID_TOKEN_TTL_SECONDS}s`)
    .sign(secret());
}

// Used by tests and by any TypeScript integration; Python integrations verify
// with PyJWT using the same secret.
export async function verifyIdToken(token: string, audience: string) {
  const { payload } = await jwtVerify(token, secret(), { audience, algorithms: ["HS256"] });
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
  return { id: payload.sub, email: payload.email, name: typeof payload.name === "string" ? payload.name : "" };
}

export function buildRedirect(redirectUri: URL, token: string, state: string | null) {
  const target = new URL(redirectUri.toString());
  target.searchParams.set("id_token", token);
  if (state) target.searchParams.set("state", state);
  return target;
}
