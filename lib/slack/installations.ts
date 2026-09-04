// Multi-workspace Slack installations.
//
// claudex is ONE Slack app that can be installed into several workspaces. The
// app-level token (SLACK_APP_TOKEN, Socket Mode) is per app, so a single socket
// receives events from every workspace; the BOT token is per workspace, so
// every outbound Slack call must pick the token for the event's team.
//
// Two sources, resolved by `slackInstallationForTeam(teamId)`:
//   1. The .env workspace: SLACK_BOT_TOKEN (+ auth.test once, cached) — the
//      implicit first installation, kept so existing deployments need no data
//      migration.
//   2. `SlackInstallation` rows written by the OAuth callback
//      (app/api/slack/oauth/callback), bot token encrypted at rest.
// Every place that used to read process.env.SLACK_BOT_TOKEN directly goes
// through this module instead; the bot token still never leaves the server.

import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "@/lib/secret-crypto";
import { createSlackWebClient, slackAuthTest, type SlackClient } from "@/lib/slack/web";

export type SlackInstallation = {
  teamId: string;
  teamName: string | null;
  botToken: string;
  botUserId: string;
  /** "env" for the .env workspace, "oauth" for a stored installation. */
  source: "env" | "oauth";
};

export type SlackTeamContext = {
  teamId: string;
  slack: SlackClient;
  botUserId: string;
  appUrl: string;
};

// Bot scopes the app needs, derived from the Web API methods lib/slack/web.ts
// calls plus the event subscriptions in lib/slack/service.ts. Keep
// slack-manifest.json in sync.
export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "reactions:write",
  "users:read"
] as const;

export function slackAppUrl() {
  return process.env.APP_URL?.trim() || "http://localhost:14141";
}

// ---------- .env workspace ----------

let envInstallationPromise: Promise<SlackInstallation | null> | null = null;
let envInstallationToken: string | null = null;

async function resolveEnvInstallation(): Promise<SlackInstallation | null> {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim() || null;
  if (!botToken) return null;
  if (!envInstallationPromise || envInstallationToken !== botToken) {
    envInstallationToken = botToken;
    envInstallationPromise = slackAuthTest(botToken)
      .then((auth) => {
        if (!auth.userId || !auth.teamId) return null;
        return {
          teamId: auth.teamId,
          teamName: null,
          botToken,
          botUserId: auth.userId,
          source: "env" as const
        };
      })
      .catch((error) => {
        console.warn("[slack] auth.test for SLACK_BOT_TOKEN failed", {
          error: error instanceof Error ? error.message : error
        });
        // Don't cache a transient failure.
        envInstallationPromise = null;
        return null;
      });
  }
  return envInstallationPromise;
}

/** The .env workspace, or null when SLACK_BOT_TOKEN is not configured/valid. */
export async function envSlackInstallation() {
  return resolveEnvInstallation();
}

// ---------- stored (OAuth) installations ----------

function decodeToken(stored: string) {
  return isEncryptedSecret(stored) ? decryptSecret(stored) : stored;
}

function fromRow(row: { teamId: string; teamName: string | null; botToken: string; botUserId: string }): SlackInstallation {
  return {
    teamId: row.teamId,
    teamName: row.teamName,
    botToken: decodeToken(row.botToken),
    botUserId: row.botUserId,
    source: "oauth"
  };
}

export async function saveSlackInstallation(input: {
  teamId: string;
  teamName?: string | null;
  botToken: string;
  botUserId: string;
  installedByUserId?: string | null;
}) {
  const row = await db.slackInstallation.upsert({
    where: { teamId: input.teamId },
    update: {
      teamName: input.teamName ?? null,
      botToken: encryptSecret(input.botToken),
      botUserId: input.botUserId,
      installedByUserId: input.installedByUserId ?? null
    },
    create: {
      teamId: input.teamId,
      teamName: input.teamName ?? null,
      botToken: encryptSecret(input.botToken),
      botUserId: input.botUserId,
      installedByUserId: input.installedByUserId ?? null
    }
  });
  return fromRow(row);
}

export async function removeSlackInstallation(teamId: string) {
  await db.slackInstallation.deleteMany({ where: { teamId } });
}

/** Resolve the installation serving `teamId` — .env workspace first, then stored rows. */
export async function slackInstallationForTeam(teamId: string): Promise<SlackInstallation | null> {
  const env = await resolveEnvInstallation();
  if (env && env.teamId === teamId) return env;
  const row = await db.slackInstallation.findUnique({ where: { teamId } });
  return row ? fromRow(row) : null;
}

/** All workspaces the bot can post into (.env workspace + stored installations). */
export async function listSlackInstallations(): Promise<SlackInstallation[]> {
  const env = await resolveEnvInstallation();
  const rows = await db.slackInstallation.findMany({ orderBy: { createdAt: "asc" } });
  const stored = rows.filter((row) => row.teamId !== env?.teamId).map(fromRow);
  return env ? [env, ...stored] : stored;
}

/** Team ids that can receive DMs — bounds fan-outs like the public forum broadcast. */
export async function installedSlackTeamIds() {
  return (await listSlackInstallations()).map((installation) => installation.teamId);
}

/** True when at least one workspace is configured (used to skip Slack work entirely). */
export async function hasAnySlackInstallation() {
  if (process.env.SLACK_BOT_TOKEN?.trim()) return true;
  return (await db.slackInstallation.count()) > 0;
}

/**
 * Web client + bot identity for one team, or null when claudex is not
 * installed there. Callers that used to build `{slack, appUrl, botUserId}` from
 * SLACK_BOT_TOKEN use this per event/task/recipient instead.
 */
export async function slackTeamContext(teamId: string): Promise<SlackTeamContext | null> {
  const installation = await slackInstallationForTeam(teamId);
  if (!installation) return null;
  return {
    teamId,
    slack: createSlackWebClient(installation.botToken),
    botUserId: installation.botUserId,
    appUrl: slackAppUrl()
  };
}

// ---------- OAuth (install into another workspace) ----------

export function slackOAuthConfig() {
  const clientId = process.env.SLACK_CLIENT_ID?.trim() || null;
  const clientSecret = process.env.SLACK_CLIENT_SECRET?.trim() || null;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: `${slackAppUrl().replace(/\/$/, "")}/api/slack/oauth/callback` };
}

export function slackOAuthAuthorizeUrl(config: { clientId: string; redirectUri: string }, state: string) {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export type SlackOAuthAccessResult = {
  teamId: string;
  teamName: string | null;
  botToken: string;
  botUserId: string;
};

/** Parse Slack's oauth.v2.access payload into what we store; null when malformed. */
export function parseSlackOAuthAccess(payload: unknown): SlackOAuthAccessResult | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  if (data.ok !== true) return null;
  const team = data.team as { id?: unknown; name?: unknown } | undefined;
  const teamId = typeof team?.id === "string" ? team.id : null;
  const botToken = typeof data.access_token === "string" ? data.access_token : null;
  const botUserId = typeof data.bot_user_id === "string" ? data.bot_user_id : null;
  if (!teamId || !botToken || !botUserId) return null;
  // Only bot installs are supported: a user-token-only response has no bot.
  if (data.token_type !== undefined && data.token_type !== "bot") return null;
  return {
    teamId,
    teamName: typeof team?.name === "string" ? team.name : null,
    botToken,
    botUserId
  };
}

export async function exchangeSlackOAuthCode(
  config: { clientId: string; clientSecret: string; redirectUri: string },
  code: string,
  fetchImpl: typeof fetch = fetch
): Promise<SlackOAuthAccessResult> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri
  });
  const response = await fetchImpl("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: params
  });
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  const parsed = parseSlackOAuthAccess(payload);
  if (!parsed) {
    throw new Error(`Slack oauth.v2.access failed: ${payload?.error ?? `http ${response.status}`}`);
  }
  return parsed;
}
