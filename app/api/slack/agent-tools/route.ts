import { NextResponse } from "next/server";
import { z } from "zod";

import { handleSlackAgentToolCall } from "@/lib/slack/agent-tools";
import { handleSlackAgentMcpMessage } from "@/lib/slack/agent-tools-mcp";
import { verifySlackToolsToken } from "@/lib/slack/link-token";
import { createSlackWebClient, slackAuthTest } from "@/lib/slack/web";

export const runtime = "nodejs";

const toolRequestSchema = z.object({
  tool: z.enum([
    "post_slack_message",
    "list_slack_channels",
    "read_slack_channel",
    "read_slack_thread",
    "recent_activity",
    "schedule_task",
    "check_back_later",
    "list_scheduled_tasks",
    "cancel_scheduled_task",
    "send_file"
  ]),
  args: z.record(z.string(), z.unknown()).default({})
});

let cachedBotUserId: string | null = null;

// HTTP callback for the agent's Slack read tools (see lib/slack/agent-tools.ts
// for the access invariant). Called from inside a running agent — including
// from inside the run container — with the run-scoped bearer token minted at
// run start. The bot token itself never leaves this process.
export async function POST(request: Request) {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  if (!botToken) {
    return NextResponse.json({ ok: false, text: "Slack is not configured on this server." }, { status: 503 });
  }

  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  const claims = token ? await verifySlackToolsToken(token) : null;
  if (!claims) {
    return NextResponse.json({ ok: false, text: "Invalid or expired run token." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!cachedBotUserId) {
    cachedBotUserId = (await slackAuthTest(botToken)).userId;
    if (!cachedBotUserId) {
      return NextResponse.json({ ok: false, text: "Slack auth.test failed." }, { status: 502 });
    }
  }
  const botUserId = cachedBotUserId;

  const execute = async (toolRequest: z.infer<typeof toolRequestSchema>) => {
    const result = await handleSlackAgentToolCall(toolRequest, {
      claims,
      slack: createSlackWebClient(botToken),
      botUserId
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
