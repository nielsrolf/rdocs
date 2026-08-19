import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getRequestOrigin } from "@/lib/request-origin";
import { verifySlackLinkToken } from "@/lib/slack/link-token";

export const runtime = "nodejs";

function page(title: string, body: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
      `<style>body{font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>` +
      `</head><body><h2>${title}</h2><p>${body}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// Completes Slack account linking: the bot posts an ephemeral URL containing a
// signed short-lived token; opening it while signed in binds that Slack
// identity to the current rdocs account.
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return page("Invalid link", "This Slack connect link is missing its token.", 400);
  }
  const claims = await verifySlackLinkToken(token);
  if (!claims) {
    return page(
      "Link expired",
      "This Slack connect link is invalid or has expired. Mention the bot again in Slack to get a fresh one.",
      400
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    return page(
      "Sign in first",
      `You need to be signed in to link your Slack account. <a href="/sign-in">Sign in</a>, then open the connect link from Slack again.`,
      401
    );
  }

  await db.slackAccountLink.upsert({
    where: {
      slackTeamId_slackUserId: { slackTeamId: claims.slackTeamId, slackUserId: claims.slackUserId }
    },
    update: { userId: user.id },
    create: { slackTeamId: claims.slackTeamId, slackUserId: claims.slackUserId, userId: user.id }
  });
  console.log("[slack] account linked", {
    userId: user.id,
    slackTeamId: claims.slackTeamId,
    slackUserId: claims.slackUserId
  });

  // Land on the claudex config screen: credential warning (free-local-model
  // fallback), credential form, and the user's default model config.
  return NextResponse.redirect(new URL("/slack/connected", getRequestOrigin(request)));
}
