import { redirect } from "next/navigation";

import { SlackConnectConfig } from "@/components/slack-connect-config";
import { getCurrentUser } from "@/lib/auth";
import { freeLocalAgentModel } from "@/lib/user-credentials";

// Landing screen after /api/slack/connect links a Slack identity to this
// account: confirms the link, warns when runs would fall back to the free
// local model, and lets the user set their personal default agent config
// (used by claudex whenever the channel document doesn't pin a model).
export default async function SlackConnectedPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/sign-in");
  }

  return (
    <main className="slack-connect-shell">
      <SlackConnectConfig email={user.email} localModel={freeLocalAgentModel()} />
    </main>
  );
}
