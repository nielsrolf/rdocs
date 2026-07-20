// Minimal Slack Web API client. Only the handful of methods the bot needs,
// behind an interface so the event handler can be tested with a fake. The bot
// token stays server-side — agent containers never see it; the agent talks to
// Slack only through server-mediated tools.

export type SlackMessage = {
  ts: string;
  user?: string;
  botId?: string;
  text: string;
};

export type SlackClient = {
  postMessage(args: { channel: string; text: string; threadTs?: string }): Promise<{ ts: string | null }>;
  postEphemeral(args: { channel: string; user: string; text: string; threadTs?: string }): Promise<void>;
  addReaction(args: { channel: string; ts: string; name: string }): Promise<void>;
  removeReaction(args: { channel: string; ts: string; name: string }): Promise<void>;
  channelInfo(channelId: string): Promise<{ name: string | null } | null>;
  userInfo(userId: string): Promise<{ displayName: string | null } | null>;
  threadReplies(args: { channel: string; ts: string; limit?: number }): Promise<SlackMessage[]>;
};

type SlackApiResponse = { ok: boolean; error?: string } & Record<string, unknown>;

async function slackApi(botToken: string, method: string, body: Record<string, unknown>) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => null)) as SlackApiResponse | null;
  if (!payload || !payload.ok) {
    throw new Error(`Slack API ${method} failed: ${payload?.error ?? `http ${response.status}`}`);
  }
  return payload;
}

// Startup-only: resolve the bot's own user id + team id.
export async function slackAuthTest(botToken: string) {
  const result = await slackApi(botToken, "auth.test", {});
  return {
    userId: typeof result.user_id === "string" ? result.user_id : null,
    teamId: typeof result.team_id === "string" ? result.team_id : null
  };
}

export function createSlackWebClient(botToken: string): SlackClient {
  return {
    async postMessage({ channel, text, threadTs }) {
      const result = await slackApi(botToken, "chat.postMessage", {
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {})
      });
      return { ts: typeof result.ts === "string" ? result.ts : null };
    },
    async postEphemeral({ channel, user, text, threadTs }) {
      await slackApi(botToken, "chat.postEphemeral", {
        channel,
        user,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {})
      });
    },
    async addReaction({ channel, ts, name }) {
      // "already_reacted" is fine (event redelivery) — don't surface it.
      await slackApi(botToken, "reactions.add", { channel, timestamp: ts, name }).catch((error) => {
        if (!String(error).includes("already_reacted")) throw error;
      });
    },
    async removeReaction({ channel, ts, name }) {
      await slackApi(botToken, "reactions.remove", { channel, timestamp: ts, name }).catch((error) => {
        if (!String(error).includes("no_reaction")) throw error;
      });
    },
    async channelInfo(channelId) {
      try {
        const result = await slackApi(botToken, "conversations.info", { channel: channelId });
        const channel = result.channel as { name?: string } | undefined;
        return { name: channel?.name ?? null };
      } catch {
        return null;
      }
    },
    async userInfo(userId) {
      try {
        const result = await slackApi(botToken, "users.info", { user: userId });
        const user = result.user as
          | { profile?: { display_name?: string; real_name?: string }; real_name?: string; name?: string }
          | undefined;
        return {
          displayName:
            user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name || null
        };
      } catch {
        return null;
      }
    },
    async threadReplies({ channel, ts, limit = 20 }) {
      const result = await slackApi(botToken, "conversations.replies", { channel, ts, limit });
      const messages = Array.isArray(result.messages) ? (result.messages as Array<Record<string, unknown>>) : [];
      return messages.map((message) => ({
        ts: typeof message.ts === "string" ? message.ts : "",
        user: typeof message.user === "string" ? message.user : undefined,
        botId: typeof message.bot_id === "string" ? message.bot_id : undefined,
        text: typeof message.text === "string" ? message.text : ""
      }));
    }
  };
}
