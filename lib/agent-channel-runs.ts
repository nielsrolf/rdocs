// Starting a run through a document's AgentApiChannel. Shared by the HTTP route
// (POST /api/agent-channels/:triggerId/runs) and the scheduler (api_channel
// tasks), so a scheduled firing is byte-for-byte the same kind of run as a
// triggered one: triggerType "API", triggerId = channel id, created by the
// channel's creator, agent config = that user's defaults for the document.

import type { AgentApiChannel, Document } from "@prisma/client";
import { z } from "zod";

import { RUN_STARTED_CLAUDE } from "@/agent-core/lifecycle-messages";
import { resolveAgentConfigForUser } from "@/lib/agent-defaults";
import { runAgentConversationInBackground } from "@/lib/agent-conversation";
import { recordAiRunEvent } from "@/lib/ai-runs";
import { db } from "@/lib/db";

/** Body of POST /api/agent-channels/:triggerId/runs. */
export const channelRunMessageSchema = z.object({
  message: z.string().trim().min(1).max(6000),
  /** Resume the harness session of an earlier run of this channel (same document). */
  previousRunId: z.string().min(1).max(64).optional().nullable()
});

export type ChannelWithDocument = Pick<AgentApiChannel, "id" | "documentId" | "createdById"> & {
  document: Pick<Document, "id" | "title" | "content" | "runnerMode" | "agentModel" | "agentEffort">;
};

export async function startAgentChannelRun(args: {
  channel: ChannelWithDocument;
  message: string;
  previousRunId?: string | null;
}): Promise<string> {
  const { channel, message } = args;
  const previousRunId = args.previousRunId ?? null;
  const aiRun = await db.aiRun.create({
    data: {
      documentId: channel.documentId,
      triggerType: "API",
      triggerId: channel.id,
      createdById: channel.createdById,
      parentRunId: previousRunId,
      instruction: message,
      progress: RUN_STARTED_CLAUDE,
      suggestOnly: true
    }
  });
  await recordAiRunEvent({ aiRunId: aiRun.id, role: "user", message });

  void runAgentConversationInBackground({
    documentId: channel.documentId,
    aiRunId: aiRun.id,
    message,
    previousRunId,
    documentTitle: channel.document.title,
    documentContent: channel.document.content,
    createdById: channel.createdById,
    agentConfig: await resolveAgentConfigForUser(channel.document, channel.createdById),
    agentAccessMode: "workspace",
    runnerMode: channel.document.runnerMode
  }).catch((error) => {
    console.error("[agent-api] background run threw", {
      channelId: channel.id,
      aiRunId: aiRun.id,
      error: error instanceof Error ? error.message : error
    });
  });
  return aiRun.id;
}
