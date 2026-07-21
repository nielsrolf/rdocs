// Signed, short-lived tokens for linking a Slack identity to an r-docs
// account. The bot posts a connect URL containing one of these; the connect
// route verifies it and upserts the SlackAccountLink for the signed-in user.
//
// Deliberately does NOT import lib/auth.ts (next/headers) so headless tests
// can exercise the round trip. Uses the same SESSION_SECRET.

import { SignJWT, jwtVerify } from "jose";

const PURPOSE = "slack-account-link";
const encoder = new TextEncoder();

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required.");
  }
  return encoder.encode(secret);
}

export type SlackLinkClaims = {
  slackTeamId: string;
  slackUserId: string;
};

export async function createSlackLinkToken(claims: SlackLinkClaims) {
  return new SignJWT({ purpose: PURPOSE, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(getSecret());
}

// Run-scoped token authorizing the agent's Slack read tools for the duration
// of one run. Carries the TRIGGERING user's Slack identity — the agent-tools
// route enforces that every channel it touches contains both the bot and this
// user, so the bot can never be used as a confused deputy to read channels the
// requester is not in.
const TOOLS_PURPOSE = "slack-agent-tools";

export type SlackToolsClaims = {
  slackTeamId: string;
  slackUserId: string;
  aiRunId: string;
};

export async function createSlackToolsToken(claims: SlackToolsClaims) {
  return new SignJWT({ purpose: TOOLS_PURPOSE, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(getSecret());
}

export async function verifySlackToolsToken(token: string): Promise<SlackToolsClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (
      payload.purpose !== TOOLS_PURPOSE ||
      typeof payload.slackTeamId !== "string" ||
      typeof payload.slackUserId !== "string" ||
      typeof payload.aiRunId !== "string"
    ) {
      return null;
    }
    return {
      slackTeamId: payload.slackTeamId,
      slackUserId: payload.slackUserId,
      aiRunId: payload.aiRunId
    };
  } catch {
    return null;
  }
}

export async function verifySlackLinkToken(token: string): Promise<SlackLinkClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (
      payload.purpose !== PURPOSE ||
      typeof payload.slackTeamId !== "string" ||
      typeof payload.slackUserId !== "string"
    ) {
      return null;
    }
    return { slackTeamId: payload.slackTeamId, slackUserId: payload.slackUserId };
  } catch {
    return null;
  }
}
