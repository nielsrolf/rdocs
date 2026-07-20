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
  tool:
    | "list_slack_channels"
    | "read_slack_channel"
    | "read_slack_thread"
    | "recent_activity"
    | "schedule_task"
    | "list_scheduled_tasks"
    | "cancel_scheduled_task"
    | "send_file";
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

  if (request.tool === "send_file") {
    // Upload a workspace file into the run's own conversation. The agent ships
    // the bytes base64 over the run-scoped callback; they land in the thread
    // the run was triggered from — never another channel.
    const run = await db.aiRun.findUnique({
      where: { id: claims.aiRunId },
      select: { triggerId: true }
    });
    if (!run?.triggerId) return { ok: false, text: "This run has no Slack conversation to send into." };
    const [channel, threadTs] = run.triggerId.split(":", 2);
    const denied = await assertReadable(slack, botUserId, claims, channel);
    if (denied) return { ok: false, text: denied };
    const filename = typeof request.args.filename === "string" ? request.args.filename.trim() : "";
    const contentBase64 = typeof request.args.content_base64 === "string" ? request.args.content_base64 : "";
    const title = typeof request.args.title === "string" ? request.args.title.trim() : undefined;
    if (!filename || !contentBase64) return { ok: false, text: "filename and content_base64 are required." };
    let content: Buffer;
    try {
      content = Buffer.from(contentBase64, "base64");
    } catch {
      return { ok: false, text: "content_base64 is not valid base64." };
    }
    if (content.length === 0) return { ok: false, text: "The file is empty." };
    if (content.length > 25 * 1024 * 1024) return { ok: false, text: "File too large (max 25 MB)." };
    await slack.uploadFile({
      channel,
      threadTs: threadTs || undefined,
      filename,
      title,
      content
    });
    return { ok: true, text: `Uploaded ${filename} (${content.length} bytes) to the thread.` };
  }

  if (
    request.tool === "schedule_task" ||
    request.tool === "list_scheduled_tasks" ||
    request.tool === "cancel_scheduled_task"
  ) {
    // Scheduling is anchored to the run's own conversation: the run row tells
    // us the document and Slack thread the tool call came from.
    const { computeNextRunAt, MAX_ACTIVE_TASKS_PER_DOCUMENT } = await import("@/lib/scheduler");
    const run = await db.aiRun.findUnique({
      where: { id: claims.aiRunId },
      select: { documentId: true, triggerId: true }
    });
    if (!run?.triggerId) {
      return { ok: false, text: "This run has no Slack conversation to schedule into." };
    }
    const link = await db.slackAccountLink.findUnique({
      where: {
        slackTeamId_slackUserId: { slackTeamId: claims.slackTeamId, slackUserId: claims.slackUserId }
      }
    });
    if (!link) {
      return { ok: false, text: "This Slack account is not linked to an rdocs account." };
    }
    const [runChannel, runThreadTs] = run.triggerId.split(":", 2);

    if (request.tool === "schedule_task") {
      const instruction = typeof request.args.instruction === "string" ? request.args.instruction.trim() : "";
      if (!instruction) return { ok: false, text: "instruction is required." };
      const cron = typeof request.args.cron === "string" ? request.args.cron.trim() : null;
      const at = typeof request.args.at === "string" ? request.args.at.trim() : null;
      const timezone = typeof request.args.timezone === "string" ? request.args.timezone.trim() : null;
      const context = request.args.context === "channel" ? "slack_channel" : "slack_thread";
      let nextRunAt: Date;
      try {
        nextRunAt = computeNextRunAt({ cron, at, timezone });
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : "Invalid schedule." };
      }
      const active = await db.scheduledTask.count({
        where: { documentId: run.documentId, disabledAt: null }
      });
      if (active >= MAX_ACTIVE_TASKS_PER_DOCUMENT) {
        return { ok: false, text: `This channel already has ${active} active scheduled tasks — cancel some first.` };
      }
      const task = await db.scheduledTask.create({
        data: {
          documentId: run.documentId,
          createdById: link.userId,
          createdByRunId: claims.aiRunId,
          instruction,
          contextType: context,
          slackTeamId: claims.slackTeamId,
          slackChannelId: runChannel,
          slackThreadTs: context === "slack_thread" ? runThreadTs ?? null : null,
          cron,
          timezone,
          nextRunAt
        }
      });
      // Visible consent: the channel learns a recurring task now exists, who
      // it runs as, and how to stop it — regardless of what the agent says.
      await slack
        .postMessage({
          channel: runChannel,
          ...(context === "slack_thread" && runThreadTs ? { threadTs: runThreadTs } : {}),
          text:
            `⏰ Scheduled task created (id ${task.id}): "${instruction.slice(0, 150)}"\n` +
            `${cron ? `Recurs: \`${cron}\`${timezone ? ` (${timezone})` : ""}` : `Runs once`} — next firing ${nextRunAt.toISOString()}. ` +
            `It runs with the scheduler's credentials. Anyone in this channel can cancel it (ask the bot to cancel scheduled task ${task.id}).`
        })
        .catch(() => null);
      return {
        ok: true,
        text: `Scheduled (id ${task.id}). Next firing: ${nextRunAt.toISOString()}${cron ? `, recurring ${cron}` : ", one-shot"}.`
      };
    }

    if (request.tool === "list_scheduled_tasks") {
      const tasks = await db.scheduledTask.findMany({
        where: { documentId: run.documentId, disabledAt: null },
        orderBy: { nextRunAt: "asc" },
        select: {
          id: true,
          instruction: true,
          cron: true,
          timezone: true,
          nextRunAt: true,
          contextType: true,
          createdBy: { select: { name: true } }
        }
      });
      if (tasks.length === 0) return { ok: true, text: "No active scheduled tasks in this channel." };
      const lines = tasks.map(
        (t) =>
          `${t.id} • ${t.cron ? `cron ${t.cron}${t.timezone ? ` (${t.timezone})` : ""}` : "one-shot"} • next ${t.nextRunAt.toISOString()} • by ${t.createdBy?.name ?? "unknown"} • ${t.contextType === "slack_channel" ? "channel" : "thread"}\n  ${t.instruction.slice(0, 160)}`
      );
      return { ok: true, text: `Active scheduled tasks:\n${lines.join("\n")}` };
    }

    // cancel_scheduled_task: anyone who can talk to the bot in the task's
    // channel may cancel — membership is re-verified against Slack.
    const taskId = typeof request.args.task_id === "string" ? request.args.task_id.trim() : "";
    if (!taskId) return { ok: false, text: "task_id is required." };
    const task = await db.scheduledTask.findUnique({ where: { id: taskId } });
    if (!task || task.disabledAt) return { ok: false, text: "No active task with that id." };
    const denied = await assertReadable(slack, botUserId, claims, task.slackChannelId);
    if (denied) return { ok: false, text: denied };
    await db.scheduledTask.update({ where: { id: taskId }, data: { disabledAt: new Date() } });
    await slack
      .postMessage({
        channel: task.slackChannelId,
        ...(task.slackThreadTs ? { threadTs: task.slackThreadTs } : {}),
        text: `⏰ Scheduled task ${task.id} cancelled.`
      })
      .catch(() => null);
    return { ok: true, text: `Cancelled scheduled task ${task.id}.` };
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
