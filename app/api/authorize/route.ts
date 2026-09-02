import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { buildRedirect, integrationSigninEnabled, issueIdToken, parseRedirectUri } from "@/lib/integration-signin";

export const runtime = "nodejs";

// Target of the consent form on /authorize. Issues the id token for the
// signed-in user and sends the browser back to the integration.
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  if (!integrationSigninEnabled()) {
    return NextResponse.json({ error: "Integration sign-in is not configured." }, { status: 404 });
  }
  const form = await request.formData().catch(() => null);
  const redirectUri = parseRedirectUri(form?.get("redirect_uri")?.toString());
  if (!redirectUri) return NextResponse.json({ error: "Redirect origin is not allowed." }, { status: 400 });
  const state = form?.get("state")?.toString().slice(0, 500) || null;
  const token = await issueIdToken(user, redirectUri.origin);
  return NextResponse.redirect(buildRedirect(redirectUri, token, state), 303);
}
