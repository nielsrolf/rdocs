// Server-side execution of the agent's Slack read tools, called back over HTTP
// from a running agent (app/api/slack/agent-tools/route.ts) with a run-scoped
// token (lib/slack/link-token.ts).
//
// THE access invariant, enforced on every call: a channel is readable iff BOTH
// the bot AND the run's triggering user are members. The bot alone being in a
// channel is never sufficient — otherwise any user could use the bot as a
// confused deputy to read private channels they are not in ("summarize what's
// going on in Alice's channel"). The membership check runs server-side against
// Slack per call, so leaving a channel takes effect immediately.

import { db } from "@/lib/db";
import type { SlackToolsClaims } from "@/lib/slack/link-token";
import type { SlackClient, SlackMessage } from "@/lib/slack/web";

export type SlackAgentToolRequest = {
  tool: "list_slack_channels" | "read_slack_channel" | "read_slack_thread" | "recent_activity";
  args: Record<string, unknown>;
};

export type SlackAgentToolResult = {
  ok: boolean;
  text: string;
};

const MAX_MESSAGES = 100;

async function assertReadable(
  slack: SlackClient,
  botUserId: string,
  claims: SlackToolsClaims,
  channelId: string
): Promise<string | null> {
  let members: string[];
  try {
    members = await slack.channelMembers(channelId);
  } catch {
    return `Channel ${channelId} is not accessible.`;
  }
  if (!members.includes(botUserId)) {
    return `The bot is not a member of ${channelId}. Ask a member to add it first.`;
  }
  if (!members.includes(claims.slackUserId)) {
    return `Access denied: the user who triggered this run is not a member of ${channelId}.`;
  }
  return null;
}

async function renderTranscript(slack: SlackClient, messages: SlackMessage[]): Promise<string> {
  const nameCache = new Map<string, string>();
  const lines: string[] = [];
  for (const message of messages) {
    if (!message.text) continue;
    let name = "unknown";
    if (message.botId) {
      name = "bot";
    } else if (message.user) {
      if (!nameCache.has(message.user)) {
        nameCache.set(message.user, (await slack.userInfo(message.user))?.displayName ?? message.user);
      }
      name = nameCache.get(message.user)!;
    }
    lines.push(`[${message.ts}] ${name}: ${message.text}`);
  }
  return lines.join("\n") || "(no messages)";
}

function clampLimit(value: unknown, fallback: number) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_MESSAGES);
}

export async function handleSlackAgentToolCall(
  request: SlackAgentToolRequest,
  context: { claims: SlackToolsClaims; slack: SlackClient; botUserId: string }
): Promise<SlackAgentToolResult> {
  const { claims, slack, botUserId } = context;

  if (request.tool === "recent_activity") {
    // Cross-project activity feed for the DM overview agent. Visibility is the
    // requesting user's OWN document access (owner or member) — resolved from
    // their Slack identity, so it can never widen beyond what they'd see on
    // the web dashboard.
    const link = await db.slackAccountLink.findUnique({
      where: {
        slackTeamId_slackUserId: { slackTeamId: claims.slackTeamId, slackUserId: claims.slackUserId }
      }
    });
    if (!link) {
      return { ok: false, text: "This Slack account is not linked to an rdocs account." };
    }
    const projectFilter =
      typeof request.args.project === "string" ? request.args.project.trim().toLowerCase() : null;
    const documents = await db.document.findMany({
      where: {
        OR: [{ ownerId: link.userId }, { memberships: { some: { userId: link.userId } } }]
      },
      select: { id: true, title: true, kind: true }
    });
    const docById = new Map(documents.map((d) => [d.id, d]));
    const scopedIds = documents
      .filter((d) => !projectFilter || d.title.toLowerCase().includes(projectFilter))
      .map((d) => d.id);
    if (scopedIds.length === 0) {
      return { ok: true, text: "No matching projects." };
    }
    const limit = clampLimit(request.args.limit, 20);
    const runs = await db.aiRun.findMany({
      where: { documentId: { in: scopedIds } },
      orderBy: { startedAt: "desc" },
      take: limit,
      select: {
        documentId: true,
        triggerType: true,
        status: true,
        instruction: true,
        progress: true,
        selectedText: true,
        startedAt: true,
        createdBy: { select: { name: true } }
      }
    });
    if (runs.length === 0) {
      return { ok: true, text: "No agent runs yet in the projects you can see." };
    }
    const lines = runs.map((run) => {
      const doc = docById.get(run.documentId);
      const project = doc ? `${doc.title}${doc.kind === "slack_channel" ? " [slack]" : " [doc]"}` : run.documentId;
      const who = run.createdBy?.name ?? "unknown";
      const prompt = run.instruction.replace(/\s+/g, " ").slice(0, 180);
      const summary =
        run.status === "SUCCEEDED" && run.progress ? ` — outcome: ${run.progress.replace(/\s+/g, " ").slice(0, 200)}` : "";
      const selection = run.selectedText ? ` (on selection: "${run.selectedText.replace(/\s+/g, " ").slice(0, 80)}")` : "";
      return `${run.startedAt.toISOString()} • ${project} • ${who} • ${run.status}\n  prompt: ${prompt}${selection}${summary}`;
    });
    return { ok: true, text: `Recent agent activity across your projects (newest first):\n${lines.join("\n")}` };
  }

  if (request.tool === "list_slack_channels") {
    // Start from the bot's channels (it only receives what it was added to),
    // then keep the ones the triggering user is also in.
    const channels = await slack.botChannels();
    const visible: string[] = [];
    for (const channel of channels.slice(0, 50)) {
      if (!channel.id) continue;
      const denied = await assertReadable(slack, botUserId, claims, channel.id);
      if (denied) continue;
      visible.push(`${channel.id}  ${channel.name ? `#${channel.name}` : "(dm)"}${channel.isPrivate ? " (private)" : ""}`);
    }
    return {
      ok: true,
      text: visible.length
        ? `Channels you can read (bot + requesting user are both members):\n${visible.join("\n")}`
        : "No channels are visible to both the bot and the requesting user."
    };
  }

  const channelId = typeof request.args.channel_id === "string" ? request.args.channel_id.trim() : "";
  if (!channelId) {
    return { ok: false, text: "channel_id is required." };
  }
  const denied = await assertReadable(slack, botUserId, claims, channelId);
  if (denied) {
    return { ok: false, text: denied };
  }

  if (request.tool === "read_slack_channel") {
    const limit = clampLimit(request.args.limit, 30);
    const messages = await slack.channelHistory({ channel: channelId, limit });
    return { ok: true, text: await renderTranscript(slack, messages) };
  }

  if (request.tool === "read_slack_thread") {
    const threadTs = typeof request.args.thread_ts === "string" ? request.args.thread_ts.trim() : "";
    if (!threadTs) {
      return { ok: false, text: "thread_ts is required." };
    }
    const limit = clampLimit(request.args.limit, 50);
    const messages = await slack.threadReplies({ channel: channelId, ts: threadTs, limit });
    return { ok: true, text: await renderTranscript(slack, messages) };
  }

  return { ok: false, text: `Unknown tool: ${(request as { tool: string }).tool}` };
}
