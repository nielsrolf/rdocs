// Socket Mode transport for the Slack bot. Started once at boot from
// instrumentation.ts when SLACK_APP_TOKEN plus at least one workspace
// (SLACK_BOT_TOKEN or a stored SlackInstallation) are configured.
// All actual event logic lives in lib/slack/events.ts; this file only wires
// the websocket, acks envelopes fast, and supplies real dependencies.

import {
  handleSlackAppMention,
  handleSlackDirectMessage,
  handleSlackThreadReply,
  type SlackIncomingMessage
} from "@/lib/slack/events";
import {
  envSlackInstallation,
  hasAnySlackInstallation,
  listSlackInstallations,
  slackAppUrl,
  slackTeamContext
} from "@/lib/slack/installations";

let started = false;
let activeSocket: { disconnect: () => Promise<void> } | null = null;
let draining = false;

// Graceful drain (blue/green deploy): disconnect the websocket so Slack stops
// round-robining events to the outgoing process. In-flight runs keep posting
// replies via the Web API (plain HTTPS), which needs no socket. Idempotent.
export async function stopSlackSocketService() {
  draining = true;
  const socket = activeSocket;
  activeSocket = null;
  if (!socket) return;
  try {
    await socket.disconnect();
    console.log("[slack] Socket Mode disconnected (drain)");
  } catch (error) {
    console.warn("[slack] socket disconnect failed (drain)", {
      error: error instanceof Error ? error.message : error
    });
  }
}

export async function startSlackSocketService() {
  if (started) return;
  const appToken = process.env.SLACK_APP_TOKEN?.trim();
  if (!appToken) {
    return;
  }
  // Multi-workspace: the socket is per APP (app token); the bot token is per
  // team and resolved per event (lib/slack/installations.ts). The .env
  // workspace is optional once OAuth installations exist.
  const envInstallation = await envSlackInstallation();
  if (!envInstallation && !(await hasAnySlackInstallation())) {
    return;
  }
  if (process.env.SLACK_BOT_TOKEN?.trim() && !envInstallation) {
    console.error("[slack] auth.test for SLACK_BOT_TOKEN returned no bot user/team id; Slack service not started.");
    return;
  }
  const appUrl = slackAppUrl();
  started = true;

  const { SocketModeClient } = await import("@slack/socket-mode");

  // Per-team {slack, botUserId} for a Socket Mode envelope. null = a workspace
  // the app is (no longer) installed in — Slack keeps sending events for a short
  // while after an uninstall.
  const teamDeps = async (teamId: string) => {
    const context = await slackTeamContext(teamId);
    if (!context) {
      console.warn("[slack] event from a workspace without an installation; ignored", { teamId });
      return null;
    }
    return { slack: context.slack, appUrl, botUserId: context.botUserId };
  };

  const socket = new SocketModeClient({ appToken });

  const toIncoming = (event: Record<string, any>, body: Record<string, any>): SlackIncomingMessage => ({
    eventId: typeof body?.event_id === "string" ? body.event_id : `${event.channel}:${event.ts}`,
    teamId: body?.team_id ?? event.team ?? envInstallation?.teamId ?? "unknown",
    channel: event.channel,
    user: event.user,
    botId: event.bot_id,
    subtype: event.subtype,
    text: event.text ?? "",
    ts: event.ts,
    threadTs: event.thread_ts,
    files: Array.isArray(event.files)
      ? event.files.map((file: Record<string, unknown>) => ({
          downloadUrl: typeof file.url_private_download === "string" ? file.url_private_download : undefined,
          name: typeof file.name === "string" ? file.name : undefined,
          mimetype: typeof file.mimetype === "string" ? file.mimetype : undefined
        }))
      : undefined
  });

  socket.on("app_mention", async ({ event, body, ack }) => {
    // Ack immediately — Slack redelivers unacked envelopes, and the run is
    // tracked in the DB anyway (same 202-style contract as the HTTP routes).
    await ack();
    // Mentions inside a DM also fire message.im — the message handler owns DMs.
    if (typeof event.channel === "string" && event.channel.startsWith("D")) return;
    try {
      const mention = toIncoming(event, body);
      const deps = await teamDeps(mention.teamId);
      if (!deps) return;
      const result = await handleSlackAppMention(mention, deps);
      console.log("[slack] app_mention", {
        channel: mention.channel,
        user: mention.user,
        ...result
      });
    } catch (error) {
      console.error("[slack] app_mention handler failed", {
        error: error instanceof Error ? error.message : error
      });
    }
  });

  // DMs: every user message is a prompt, no mention required. Channel thread
  // replies to existing claudex conversations also come through here (that is
  // how "wait" works without re-mentioning the bot) — requires the message.channels
  // + message.groups event subscriptions in the Slack app config.
  socket.on("message", async ({ event, body, ack }) => {
    await ack();
    const isDm = event.channel_type === "im";
    const isChannel = event.channel_type === "channel" || event.channel_type === "group";
    if (!isDm && !(isChannel && event.thread_ts)) return;
    try {
      const message = toIncoming(event, body);
      const deps = await teamDeps(message.teamId);
      if (!deps) return;
      const result = isDm
        ? await handleSlackDirectMessage(message, deps)
        : await handleSlackThreadReply(message, deps);
      // Our own replies echo back as message events, and most channel thread
      // replies have no claudex session — don't log that noise.
      if (result.handled || (result.reason !== "bot-message" && result.reason !== "no-session")) {
        console.log("[slack] dm", {
          channel: message.channel,
          user: message.user,
          ...result
        });
      }
    } catch (error) {
      console.error("[slack] dm handler failed", {
        error: error instanceof Error ? error.message : error
      });
    }
  });

  socket.on("disconnected", () => {
    if (draining) return;
    console.warn("[slack] socket disconnected; client will reconnect automatically.");
  });

  if (draining) {
    // Drain began while we were still handshaking — don't connect at all.
    started = false;
    return;
  }
  await socket.start();
  activeSocket = socket;
  console.log("[slack] Socket Mode connected", {
    envTeamId: envInstallation?.teamId ?? null,
    installedTeamIds: (await listSlackInstallations()).map((installation) => installation.teamId)
  });
}
