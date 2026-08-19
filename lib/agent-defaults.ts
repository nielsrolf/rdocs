import { db } from "@/lib/db";

// Shared agent-config resolution for every agent entry point (doc conversation,
// selection edit, comment reply, Slack runs).
//
// The document's explicit agent config (set in its agent panel) wins; when a
// field is unset there, fall back to the triggering user's personal default
// (User.defaultAgentModel/-Effort, set on /settings/agent or the Slack connect
// screen), and finally to the app default downstream (sonnet-5, thinking off).
// Anonymous triggers (share links) skip the user step.
//
// userInstructions is different from model/effort: it is NOT doc-overridable.
// It is the triggering user's personal custom-instructions text
// (User.agentInstructions, set on /settings/agent) and rides along on every
// run that user starts — the run-input builders inject it into the agent
// system prompt (buildSystemPrompt in agent-core/agent.ts, shared by both
// harnesses).
export type ResolvedAgentConfig = {
  model: string | null;
  effort: string | null;
  userInstructions: string | null;
};

export async function resolveAgentConfigForUser(
  document: { agentModel: string | null; agentEffort: string | null },
  userId: string | null
): Promise<ResolvedAgentConfig> {
  let model = document.agentModel;
  let effort = document.agentEffort;
  let userInstructions: string | null = null;
  if (userId) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { defaultAgentModel: true, defaultAgentEffort: true, agentInstructions: true }
    });
    model = model ?? user?.defaultAgentModel ?? null;
    effort = effort ?? user?.defaultAgentEffort ?? null;
    userInstructions = user?.agentInstructions?.trim() || null;
  }
  return { model, effort, userInstructions };
}
