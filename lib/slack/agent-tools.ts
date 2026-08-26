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
import type { SlackEventDeps } from "@/lib/slack/events";
import type { SlackToolsClaims } from "@/lib/slack/link-token";
import { markdownToMrkdwn } from "@/lib/slack/mrkdwn";
import type { SlackClient, SlackMessage } from "@/lib/slack/web";

export type SlackAgentToolRequest = {
  tool:
    | "post_slack_message"
    | "message_thread"
    | "list_slack_channels"
    | "read_slack_channel"
    | "read_slack_thread"
    | "recent_activity"
    | "schedule_task"
    | "check_back_later"
    | "keep_alive_after_turn"
    | "list_scheduled_tasks"
    | "cancel_scheduled_task"
    | "send_file"
    | "set_channel_workspace"
    | "set_channel_repository";
  args: Record<string, unknown>;
};

export type SlackAgentToolResult = {
  ok: boolean;
  text: string;
};

const MAX_MESSAGES = 100;
// Upper bound for a check_back_later self-alarm. Longer waits are a standing
// job, not "I'm waiting for this run to finish" — use schedule_task for those.
const MAX_CHECK_BACK_MINUTES = 24 * 60;

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
  context: {
    claims: SlackToolsClaims;
    slack: SlackClient;
    botUserId: string;
    /** Base URL handed to runs started by message_thread (defaults to APP_URL). */
    appUrl?: string;
    /** Injectable run starter / steering hook, for tests (see SlackEventDeps). */
    startRun?: SlackEventDeps["startRun"];
    injectRunMessage?: SlackEventDeps["injectRunMessage"];
  }
): Promise<SlackAgentToolResult> {
  const { claims, slack, botUserId } = context;

  if (request.tool === "post_slack_message") {
    const run = await db.aiRun.findUnique({
      where: { id: claims.aiRunId },
      select: { triggerId: true }
    });
    if (!run?.triggerId) return { ok: false, text: "This run has no Slack conversation to post into." };
    const [channel, rawThreadTs] = run.triggerId.split(":", 2);
    const denied = await assertReadable(slack, botUserId, claims, channel);
    if (denied) return { ok: false, text: denied };
    const text = typeof request.args.text === "string" ? request.args.text.trim() : "";
    if (!text) return { ok: false, text: "text is required." };
    await slack.postMessage({
      channel,
      ...(rawThreadTs && rawThreadTs !== "dm" ? { threadTs: rawThreadTs } : {}),
      text: markdownToMrkdwn(text.slice(0, 2000))
    });
    return { ok: true, text: "Posted. Do not repeat this update in the final reply." };
  }

  // message_thread: the supervisor capability. The agent working in one thread
  // sends a message into ANOTHER thread, where it is treated exactly like a
  // human Slack message — it steers that thread's live agent session, or starts
  // a new run there. Two things must hold:
  //  - Access is the SAME rule as the read tools (assertReadable): bot AND the
  //    triggering user are members of the target channel. Anything weaker would
  //    make the bot a confused deputy that can drive work in channels the
  //    requesting user cannot even see.
  //  - It is always visible in Slack first, prefixed with where it came from, so
  //    humans in the target thread see who is driving their agent.
  if (request.tool === "message_thread") {
    const run = await db.aiRun.findUnique({
      where: { id: claims.aiRunId },
      select: { triggerId: true }
    });
    if (!run?.triggerId) {
      return { ok: false, text: "This run has no Slack conversation, so it cannot message other threads." };
    }
    const [runChannel, runThreadTs] = run.triggerId.split(":", 2);
    const channelId = typeof request.args.channel_id === "string" ? request.args.channel_id.trim() : "";
    const threadTs = typeof request.args.thread_ts === "string" ? request.args.thread_ts.trim() : "";
    const text = typeof request.args.text === "string" ? request.args.text.trim() : "";
    if (!channelId) return { ok: false, text: "channel_id is required." };
    if (!text) return { ok: false, text: "text is required." };
    // Loop guard: messaging your own conversation would make you steer (or
    // re-trigger) yourself. Omitting thread_ts in your own channel is the same
    // trap one level up, so both are refused.
    if (channelId === runChannel && (!threadTs || threadTs === runThreadTs)) {
      return {
        ok: false,
        text:
          "That is your own conversation — message_thread is only for OTHER threads. " +
          "Reply normally with submit_response, or post an interim update with post_slack_message."
      };
    }
    const denied = await assertReadable(slack, botUserId, claims, channelId);
    if (denied) return { ok: false, text: denied };
    const link = await db.slackAccountLink.findUnique({
      where: {
        slackTeamId_slackUserId: { slackTeamId: claims.slackTeamId, slackUserId: claims.slackUserId }
      }
    });
    if (!link) {
      return { ok: false, text: "This Slack account is not linked to an rdocs account." };
    }

    const originName = (await slack.channelInfo(runChannel))?.name ?? null;
    const originLabel = originName ? `#${originName.replace(/^#/, "")}` : runChannel;
    const senderName = `the claudex agent working in ${originLabel}`;
    const body = text.slice(0, 2000);
    const posted = await slack.postMessage({
      channel: channelId,
      ...(threadTs ? { threadTs } : {}),
      text: `:robot_face: Message from ${senderName} (on behalf of <@${claims.slackUserId}>):\n${markdownToMrkdwn(body)}`
    });
    const anchorTs = posted.ts ?? undefined;
    if (!threadTs && !anchorTs) {
      return {
        ok: false,
        text: "Slack did not return a timestamp for the posted message, so no agent run could be started there."
      };
    }

    const { deliverSlackThreadMessage } = await import("@/lib/slack/events");
    const delivery = await deliverSlackThreadMessage({
      deps: {
        slack,
        botUserId,
        appUrl: context.appUrl ?? process.env.APP_URL?.trim() ?? "http://localhost:14141",
        startRun: context.startRun,
        injectRunMessage: context.injectRunMessage
      },
      teamId: claims.slackTeamId,
      channel: channelId,
      threadTs: threadTs || undefined,
      anchorTs,
      senderName,
      text: body,
      instruction: `Message from ${senderName}:\n\n${body}`,
      userId: link.userId,
      slackUserId: claims.slackUserId
    });
    const where = `${originLabel === channelId ? channelId : channelId} thread ${delivery.threadTs}`;
    if (delivery.outcome === "steered") {
      return {
        ok: true,
        text:
          `Delivered: it steered the agent run already working in ${where} (run ${delivery.aiRunId}). ` +
          `That agent replies in ITS thread, not to you — read it later with read_slack_thread if you need the answer.`
      };
    }
    if (delivery.outcome === "queued") {
      return {
        ok: true,
        text:
          `Posted, and queued for ${where}: a run there is busy and could not be steered, so your message ` +
          `becomes a follow-up run as soon as it finishes (run ${delivery.aiRunId}).`
      };
    }
    return {
      ok: true,
      text:
        `Posted, and started a new agent run in ${where} (run ${delivery.aiRunId}). ` +
        `It replies in that thread — read it later with read_slack_thread if you need the answer.`
    };
  }

  // set_channel_workspace: make a regular document the backing document of
  // THIS Slack channel. The temporary slack_channel document is merged away,
  // so the target doc supplies content, env and agent settings and owns future
  // run history. Authorization is three-layered: channel membership, a linked
  // rdocs account, and EDIT access to the target document.
  if (request.tool === "set_channel_workspace") {
    const run = await db.aiRun.findUnique({
      where: { id: claims.aiRunId },
      select: { documentId: true, triggerId: true }
    });
    if (!run?.triggerId) {
      return { ok: false, text: "This run has no Slack conversation." };
    }
    const [runChannel] = run.triggerId.split(":", 2);
    const denied = await assertReadable(slack, botUserId, claims, runChannel);
    if (denied) return { ok: false, text: denied };
    const channelDoc = await db.document.findUnique({
      where: { id: run.documentId },
      select: { id: true, kind: true, slackTeamId: true, slackChannelId: true }
    });
    if (!channelDoc?.slackTeamId || !channelDoc.slackChannelId) {
      return { ok: false, text: "This conversation is not backed by a Slack channel document." };
    }
    const link = await db.slackAccountLink.findUnique({
      where: {
        slackTeamId_slackUserId: { slackTeamId: claims.slackTeamId, slackUserId: claims.slackUserId }
      }
    });
    if (!link) {
      return { ok: false, text: "This Slack account is not linked to an rdocs account." };
    }
    const raw = typeof request.args.document === "string" ? request.args.document.trim() : "";
    if (!raw) {
      return {
        ok: false,
        text: 'document is required: a document id or URL (or "none" to disconnect).'
      };
    }
    const urlMatch = raw.match(/\/documents\/([A-Za-z0-9_-]+)/);
    const targetId = raw.toLowerCase() === "none" ? null : urlMatch ? urlMatch[1] : raw;
    const { setSlackChannelDocument, WorkspaceLinkError } = await import("@/lib/workspace-link");
    try {
      const result = await setSlackChannelDocument({
        documentId: channelDoc.id,
        targetDocumentId: targetId,
        userId: link.userId
      });
      if (result.action === "merged") {
        return {
          ok: true,
          text:
            `This channel now uses "${result.target.title}" (${result.target.id}) as its document. ` +
            `The separate Slack channel document was merged into it and deleted. The document's ` +
            `content, environment, agent settings, workspace, and agent history now apply here.`
        };
      }
      if (result.action === "moved") {
        return {
          ok: true,
          text:
            `This channel now uses "${result.target.title}" (${result.target.id}) as its document. ` +
            `Future channel runs use that document's content, environment, agent settings, workspace, ` +
            `and agent history.`
        };
      }
      if (result.action === "unchanged") {
        return {
          ok: true,
          text: `This channel already uses "${result.target.title}" (${result.target.id}) as its document.`
        };
      }
      if (result.action === "unbound") {
        return {
          ok: true,
          text:
            "Channel disconnected from this document. The document remains unchanged; the next Slack " +
            "message in this channel creates a separate channel document again."
        };
      }
      return {
        ok: true,
        text: "Legacy workspace link disconnected; this channel uses its own channel document again."
      };
    } catch (error) {
      if (error instanceof WorkspaceLinkError) {
        return { ok: false, text: error.message };
      }
      throw error;
    }
  }

  // set_channel_repository: link the document backing THIS Slack channel to a
  // Git repository. The run id is the authority for choosing the document;
  // the model cannot name an arbitrary document. The triggering Slack user
  // must map to an rdocs user with EDIT access to that backing document.
  if (request.tool === "set_channel_repository") {
    const run = await db.aiRun.findUnique({
      where: { id: claims.aiRunId },
      select: { documentId: true, triggerId: true }
    });
    if (!run?.triggerId) {
      return { ok: false, text: "This run has no Slack conversation." };
    }
    const [runChannel] = run.triggerId.split(":", 2);
    const denied = await assertReadable(slack, botUserId, claims, runChannel);
    if (denied) return { ok: false, text: denied };
    const document = await db.document.findUnique({
      where: { id: run.documentId },
      select: { id: true, title: true, slackTeamId: true, slackChannelId: true }
    });
    if (!document?.slackTeamId || !document.slackChannelId) {
      return { ok: false, text: "This conversation is not backed by a Slack channel document." };
    }
    const link = await db.slackAccountLink.findUnique({
      where: {
        slackTeamId_slackUserId: { slackTeamId: claims.slackTeamId, slackUserId: claims.slackUserId }
      }
    });
    if (!link) {
      return { ok: false, text: "This Slack account is not linked to an rdocs account." };
    }
    const { resolveDocumentAccess } = await import("@/lib/permissions");
    const access = await resolveDocumentAccess(document.id, link.userId);
    if (access?.permission !== "EDIT") {
      return { ok: false, text: "You need edit access to the channel's document to change its repository." };
    }

    const rawRepository =
      typeof request.args.repository === "string" ? request.args.repository.trim() : "";
    if (!rawRepository) {
      return { ok: false, text: 'repository is required: a repository URL (or "none" to disconnect).' };
    }
    const rawBranch = typeof request.args.branch === "string" ? request.args.branch : null;
    const {
      DocumentRepositoryError,
      normalizeRepositoryBranch,
      normalizeRepositoryUrl,
      setDocumentRepository
    } = await import("@/lib/document-repository");
    const repoUrl = normalizeRepositoryUrl(rawRepository);
    const repoBranch = normalizeRepositoryBranch(rawBranch);
    try {
      const result = await setDocumentRepository({
        documentId: document.id,
        userId: link.userId,
        repoUrl,
        repoBranch
      });
      if (!repoUrl) {
        return { ok: true, text: `Removed the linked repository from "${document.title}".` };
      }
      const branchText = repoBranch ? ` on branch ${repoBranch}` : " using its default branch";
      const accessWarning =
        result.access && !result.access.ok
          ? " Warning: the available GitHub credential could not currently read this repository."
          : result.access?.reason === "check-failed"
            ? " Warning: GitHub access could not be verified right now."
            : "";
      return {
        ok: true,
        text: `Linked "${document.title}" to ${repoUrl}${branchText}.${accessWarning}`
      };
    } catch (error) {
      if (error instanceof DocumentRepositoryError) {
        return { ok: false, text: error.message };
      }
      throw error;
    }
  }

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

  // Runtime control for the Codex harness. Claude implements this as an
  // in-process SDK tool; Codex reaches tools over MCP and observes this
  // successful result to hold its own app-server/container open. There is no
  // durable server-side flag: the live harness is the state owner.
  if (request.tool === "keep_alive_after_turn") {
    if (typeof request.args.enabled !== "boolean") {
      return { ok: false, text: "enabled must be a boolean." };
    }
    const note = typeof request.args.note === "string" ? request.args.note.trim().slice(0, 2000) : "";
    return {
      ok: true,
      text: request.args.enabled
        ? `KEEP-ALIVE ON: this runtime stays alive across turn ends until you call keep_alive_after_turn with enabled=false.${
            note ? ` Note: ${note}` : ""
          } Do not submit a final response while it is on.`
        : "KEEP-ALIVE OFF: this runtime may end after the turn. Submit the final response only when background work is finished or disposable."
    };
  }

  if (
    request.tool === "schedule_task" ||
    request.tool === "check_back_later" ||
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
      // Visible consent — but only where it informs someone other than the
      // scheduler: in shared channels, members learn a task now exists, who it
      // runs as, and how to stop it, regardless of what the agent says. In a
      // 1:1 DM the only human IS the scheduler, so the announcement is pure
      // noise (the agent's own reply confirms the schedule); skip it there.
      if (!runChannel.startsWith("D")) {
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
      }
      return {
        ok: true,
        text: `Scheduled (id ${task.id}). Next firing: ${nextRunAt.toISOString()}${cron ? `, recurring ${cron}` : ", one-shot"}.`
      };
    }

    // check_back_later: the agent's own alarm clock. It is a schedule_task
    // one-shot in the run's own thread, with two deliberate differences:
    //  - no consent announcement. The wake-up lands in a conversation the same
    //    people are already watching, and nothing keeps running afterwards, so
    //    the "⏰ Scheduled task created … anyone can cancel it" notice would be
    //    pure noise. (schedule_task keeps it: that one installs a standing job.)
    //  - the result text tells the agent to END ITS TURN. That is the whole
    //    point: instead of babysitting a long job with sleep/poll loops (which
    //    burns the context window and dies with the run), the agent detaches the
    //    work, sets the alarm, and stops. The wake-up arrives as a normal
    //    message in this thread — and because a firing reminder is injected into
    //    a live session when one exists, one thread still means one session.
    //    Ending the TURN is not the same as ending the RUN: for waits within the
    //    keep-alive limit the harness parks the session with its steering channel
    //    open (agent-core/turn-park.ts), so the container, the worktree and the
    //    agent's background processes are still there when the wake-up injects.
    if (request.tool === "check_back_later") {
      const instruction = typeof request.args.instruction === "string" ? request.args.instruction.trim() : "";
      if (!instruction) {
        return {
          ok: false,
          text:
            "instruction is required: write the self-contained note your future self needs " +
            "(what was started, where its logs/artifacts are, how to tell whether it finished, what to do next)."
        };
      }
      const rawMinutes =
        typeof request.args.after_minutes === "number"
          ? request.args.after_minutes
          : Number(request.args.after_minutes);
      if (!Number.isFinite(rawMinutes) || rawMinutes < 1 || rawMinutes > MAX_CHECK_BACK_MINUTES) {
        return {
          ok: false,
          text: `after_minutes must be a number between 1 and ${MAX_CHECK_BACK_MINUTES} (24h).`
        };
      }
      const minutes = Math.round(rawMinutes);
      const active = await db.scheduledTask.count({
        where: { documentId: run.documentId, disabledAt: null }
      });
      if (active >= MAX_ACTIVE_TASKS_PER_DOCUMENT) {
        return { ok: false, text: `This channel already has ${active} active scheduled tasks — cancel some first.` };
      }
      const nextRunAt = new Date(Date.now() + minutes * 60_000);
      const task = await db.scheduledTask.create({
        data: {
          documentId: run.documentId,
          createdById: link.userId,
          createdByRunId: claims.aiRunId,
          // Framed as the agent's own note so the firing reads as "you asked to
          // be woken up", not as a standing job someone configured.
          instruction:
            `[check_back_later wake-up — the note you left for yourself]\n${instruction}\n\n` +
            `(If the background work is still running, call check_back_later again rather than waiting for it.)`,
          contextType: "slack_thread",
          slackTeamId: claims.slackTeamId,
          slackChannelId: runChannel,
          slackThreadTs: runThreadTs ?? null,
          cron: null,
          timezone: null,
          nextRunAt
        }
      });
      return {
        ok: true,
        text:
          `Wake-up set for ${nextRunAt.toISOString()} (in ${minutes} min, id ${task.id}). ` +
          `END YOUR TURN NOW. Do not sleep, poll, or otherwise wait for the background work — ` +
          `the wake-up reaches you in this thread either way, carrying your instruction back to you.`
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
    // Same DM rule as creation: only announce cancellations where other
    // channel members could care; in a 1:1 DM the agent's reply is enough.
    if (!task.slackChannelId.startsWith("D")) {
      await slack
        .postMessage({
          channel: task.slackChannelId,
          ...(task.slackThreadTs ? { threadTs: task.slackThreadTs } : {}),
          text: `⏰ Scheduled task ${task.id} cancelled.`
        })
        .catch(() => null);
    }
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
