// Socket Mode transport for the Slack bot. Started once at boot from
// instrumentation.ts when SLACK_BOT_TOKEN + SLACK_APP_TOKEN are configured.
// All actual event logic lives in lib/slack/events.ts; this file only wires
// the websocket, acks envelopes fast, and supplies real dependencies.

import {
  handleSlackAppMention,
  handleSlackDirectMessage,
  type SlackIncomingMessage
} from "@/lib/slack/events";
import { createSlackWebClient, slackAuthTest } from "@/lib/slack/web";

let started = false;

export async function startSlackSocketService() {
  if (started) return;
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  const appToken = process.env.SLACK_APP_TOKEN?.trim();
  if (!botToken || !appToken) {
    return;
  }
  const appUrl = process.env.APP_URL?.trim() || "http://localhost:14141";
  started = true;

  const { SocketModeClient } = await import("@slack/socket-mode");
  const slack = createSlackWebClient(botToken);
  const auth = await slackAuthTest(botToken);
  if (!auth.userId) {
    console.error("[slack] auth.test returned no bot user id; Slack service not started.");
    started = false;
    return;
  }
  const botUserId = auth.userId;

  const socket = new SocketModeClient({ appToken });

  const toIncoming = (event: Record<string, any>, body: Record<string, any>): SlackIncomingMessage => ({
    eventId: typeof body?.event_id === "string" ? body.event_id : `${event.channel}:${event.ts}`,
    teamId: body?.team_id ?? event.team ?? auth.teamId ?? "unknown",
    channel: event.channel,
    user: event.user,
    botId: event.bot_id,
    subtype: event.subtype,
    text: event.text ?? "",
    ts: event.ts,
    threadTs: event.thread_ts
  });

  socket.on("app_mention", async ({ event, body, ack }) => {
    // Ack immediately — Slack redelivers unacked envelopes, and the run is
    // tracked in the DB anyway (same 202-style contract as the HTTP routes).
    await ack();
    // Mentions inside a DM also fire message.im — the message handler owns DMs.
    if (typeof event.channel === "string" && event.channel.startsWith("D")) return;
    try {
      const mention = toIncoming(event, body);
      const result = await handleSlackAppMention(mention, { slack, appUrl, botUserId });
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

  // DMs: every user message is a prompt, no mention required.
  socket.on("message", async ({ event, body, ack }) => {
    await ack();
    if (event.channel_type !== "im") return;
    try {
      const message = toIncoming(event, body);
      const result = await handleSlackDirectMessage(message, { slack, appUrl, botUserId });
      // Our own replies echo back as message.im events — don't log that noise.
      if (result.handled || result.reason !== "bot-message") {
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
    console.warn("[slack] socket disconnected; client will reconnect automatically.");
  });

  await socket.start();
  console.log("[slack] Socket Mode connected", { botUserId, teamId: auth.teamId });
}
