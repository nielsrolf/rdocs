import { NextResponse } from "next/server";
import { z } from "zod";

import { handleSlackAgentToolCall } from "@/lib/slack/agent-tools";
import { handleSlackAgentMcpMessage } from "@/lib/slack/agent-tools-mcp";
import { slackTeamContext } from "@/lib/slack/installations";
import { verifySlackToolsToken } from "@/lib/slack/link-token";

export const runtime = "nodejs";

const toolRequestSchema = z.object({
  tool: z.enum([
    "post_slack_message",
    "message_thread",
    "list_slack_channels",
    "read_slack_channel",
    "read_slack_thread",
    "recent_activity",
    "schedule_task",
    "check_back_later",
    "keep_alive_after_turn",
    "list_scheduled_tasks",
    "cancel_scheduled_task",
    "send_file",
    "set_channel_workspace",
    "set_channel_repository"
  ]),
  args: z.record(z.string(), z.unknown()).default({})
});

// HTTP callback for the agent's Slack read tools (see lib/slack/agent-tools.ts
// for the access invariant). Called from inside a running agent — including
// from inside the run container — with the run-scoped bearer token minted at
// run start. The bot token itself never leaves this process.
export async function POST(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  const claims = token ? await verifySlackToolsToken(token) : null;
  if (!claims) {
    return NextResponse.json({ ok: false, text: "Invalid or expired run token." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  // Bot token + identity for the RUN's workspace (multi-workspace installs).
  const team = await slackTeamContext(claims.slackTeamId);
  if (!team) {
    return NextResponse.json({ ok: false, text: "Slack is not configured for this workspace." }, { status: 503 });
  }

  const execute = async (toolRequest: z.infer<typeof toolRequestSchema>) => {
    const result = await handleSlackAgentToolCall(toolRequest, {
      claims,
      slack: team.slack,
      botUserId: team.botUserId
    });
    console.log("[slack] agent tool call", {
      aiRunId: claims.aiRunId,
      tool: toolRequest.tool,
      ok: result.ok
    });
    return result;
  };

  try {
    if (body && typeof body === "object" && !Array.isArray(body) && "jsonrpc" in body) {
      const payload = await handleSlackAgentMcpMessage(body, execute);
      return payload === null
        ? new Response(null, { status: 202 })
        : NextResponse.json(payload);
    }
    const parsed = toolRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, text: "Invalid tool request payload." }, { status: 400 });
    }
    return NextResponse.json(await execute(parsed.data));
  } catch (error) {
    return NextResponse.json(
      { ok: false, text: `Tool failed: ${error instanceof Error ? error.message : "unknown error"}` },
      { status: 200 }
    );
  }
}
