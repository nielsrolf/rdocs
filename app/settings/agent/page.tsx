import { redirect } from "next/navigation";

import { SlackConnectConfig } from "@/components/slack-connect-config";
import { getCurrentUser } from "@/lib/auth";
import { freeLocalAgentModel } from "@/lib/user-credentials";

// Always-reachable agent settings screen (default model, AI credentials,
// self-hosted worker). Same component as the post-Slack-connect landing page,
// with a neutral banner. Linked from the topbar "AI credentials" menu.
export default async function AgentSettingsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/sign-in");
  }

  return (
    <main className="slack-connect-shell">
      <SlackConnectConfig
        email={user.email}
        localModel={freeLocalAgentModel()}
        variant="settings"
      />
    </main>
  );
}
