// Signed, short-lived tokens for linking a Slack identity to a gdocs-ai
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
