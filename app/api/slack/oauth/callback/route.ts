import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { verifySlackInstallStateToken } from "@/lib/slack/link-token";
import {
  exchangeSlackOAuthCode,
  saveSlackInstallation,
  slackOAuthConfig
} from "@/lib/slack/installations";

export const runtime = "nodejs";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char
  );
}

function page(title: string, body: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<style>body{font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>` +
      `</head><body><h2>${escapeHtml(title)}</h2><p>${body}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// Slack redirects here after the workspace approved the install. Exchanges the
// code for that workspace's bot token and stores it (encrypted) as a
// SlackInstallation; the Socket Mode service picks the token up per event, so
// no restart is needed.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const config = slackOAuthConfig();
  if (!config) {
    return page("Slack OAuth not configured", "This server has no SLACK_CLIENT_ID / SLACK_CLIENT_SECRET.", 503);
  }
  const denied = url.searchParams.get("error");
  if (denied) {
    return page("Installation cancelled", `Slack reported: <code>${escapeHtml(denied)}</code>.`, 400);
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return page(
      "Invalid install link",
      `Slack did not return an authorization code. Start again from <a href="/settings/notifications">Settings → Notifications</a> ` +
        `or from the app's distribution link.`,
      400
    );
  }
  // `state` is only present for installs started from /api/slack/install; it
  // attributes the install to the signed-in rdocs user. Slack's own sharable
  // distribution link ("Add to Slack" from api.slack.com) carries no state, and
  // so does a state that expired while the workspace admin sat on Slack's
  // approval page — both are still real installs (the code is bound to our
  // client id + redirect URI and single-use), so they are accepted and
  // attributed to whoever is signed in here, if anyone. The worst an attacker
  // can do by forging this request is register a workspace they control, which
  // the unlisted-public install already permits.
  const state = url.searchParams.get("state");
  const claims = state ? await verifySlackInstallStateToken(state) : null;
  const installedByUserId = claims?.userId ?? (await getCurrentUser().catch(() => null))?.id ?? null;
  const source = claims ? "settings-button" : state ? "expired-state" : "distribution-link";
  try {
    const access = await exchangeSlackOAuthCode(config, code);
    await saveSlackInstallation({ ...access, installedByUserId });
    console.log("[slack] workspace installed", {
      teamId: access.teamId,
      teamName: access.teamName,
      installedByUserId,
      source
    });
    return page(
      "claudex installed",
      `claudex is now installed in <strong>${escapeHtml(access.teamName ?? access.teamId)}</strong>. ` +
        `Invite the bot to a channel and mention it; each member links their Slack identity to their rdocs ` +
        `account on first use.`
    );
  } catch (error) {
    console.error("[slack] workspace install failed", {
      error: error instanceof Error ? error.message : error
    });
    return page("Installation failed", `Slack rejected the install: ${escapeHtml(error instanceof Error ? error.message : "unknown error")}`, 502);
  }
}
