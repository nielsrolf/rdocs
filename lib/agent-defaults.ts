import { db } from "@/lib/db";

// Shared agent-config resolution for every agent entry point (doc conversation,
// selection edit, comment reply, Slack runs).
//
// The document's explicit agent config (set in its agent panel) wins; when a
// field is unset there, fall back to the triggering user's personal default
// (User.defaultAgentModel/-Effort, set on /settings/agent or the Slack connect
// screen), and finally to the app default downstream (sonnet-5, thinking off).
// Anonymous triggers (share links) skip the user step.
export async function resolveAgentConfigForUser(
  document: { agentModel: string | null; agentEffort: string | null },
  userId: string | null
): Promise<{ model: string | null; effort: string | null }> {
  let model = document.agentModel;
  let effort = document.agentEffort;
  if (userId && (model == null || effort == null)) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { defaultAgentModel: true, defaultAgentEffort: true }
    });
    model = model ?? user?.defaultAgentModel ?? null;
    effort = effort ?? user?.defaultAgentEffort ?? null;
  }
  return { model, effort };
}
