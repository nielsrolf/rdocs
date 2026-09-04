import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { createSlackInstallStateToken } from "@/lib/slack/link-token";
import { slackOAuthAuthorizeUrl, slackOAuthConfig } from "@/lib/slack/installations";

export const runtime = "nodejs";

// Starts the "add claudex to another Slack workspace" OAuth flow. Requires a
// signed-in rdocs user (recorded as the installer) and SLACK_CLIENT_ID +
// SLACK_CLIENT_SECRET. The Slack app itself stays unlisted: only people who
// have this URL can install it, and Slack still requires the target
// workspace's approval.
export async function GET(request: Request) {
  const config = slackOAuthConfig();
  if (!config) {
    return NextResponse.json(
      { error: "Slack OAuth is not configured on this server (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET)." },
      { status: 503 }
    );
  }
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }
  const state = await createSlackInstallStateToken({ userId: user.id });
  return NextResponse.redirect(slackOAuthAuthorizeUrl(config, state));
}
