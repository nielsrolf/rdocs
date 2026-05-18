import { db } from "@/lib/db";

export async function recordAiRunEvent(input: {
  aiRunId: string;
  role: "system" | "user" | "agent" | "tool" | "tool_result" | "error";
  message: string;
}) {
  const message = input.message.trim();
  if (!message) {
    return;
  }

  await db.aiRunEvent.create({
    data: {
      aiRunId: input.aiRunId,
      role: input.role,
      message
    }
  });
}

export function serializeAiRun(run: {
  id: string;
  triggerType: string;
  triggerId: string | null;
  instruction: string;
  status: string;
  progress: string | null;
  model?: string | null;
  workspacePath?: string | null;
  branchName?: string | null;
  commitSha?: string | null;
  commitUrl?: string | null;
  error?: string | null;
  startedAt: Date;
  finishedAt?: Date | null;
  events?: Array<{
    id: string;
    role: string;
    message: string;
    createdAt: Date;
  }>;
}) {
  return {
    ...run,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    events: run.events ?? []
  };
}
